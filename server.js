// server.js
// Run: node server.js
// One-time: npx playwright install --with-deps
// Ensure package.json has: { "type": "module" }  (ESM)

import express from 'express';
import cors from 'cors';
import { chromium, devices } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- Health ----------
app.get('/healthz', (_req, res) => res.send('ok'));

// ---------- Auth (x-api-key or ?key=...) ----------
app.use((req, res, next) => {
  const AUTH_TOKEN = process.env.SCRAPER_TOKEN || '';
  if (!AUTH_TOKEN) return next(); // no auth if not set
  const token = req.get('x-api-key') || req.query.key;
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// ---------- Widget identity (envs optional) ----------
const WALLA_UUID = process.env.WALLA_UUID || '3f4c5689-8468-47d5-a722-c0ab605b2da4';
const WALLA_LOCATION_ID = process.env.WALLA_LOCATION_ID || '3589';

// ---------- Local HTML shell for the widget ----------
const LOCAL_HTML = ({ start, end }) =>
  '<!doctype html><html><head><meta charset="utf-8"/></head><body>' +
  '<div class="walla-widget-root" ' +
  `data-walla-id="${WALLA_UUID}" ` +
  'data-walla-page="classes" ' +
  `data-walla-locationid="${WALLA_LOCATION_ID}" ` +
  `data-start="${start || ''}" data-end="${end || ''}"></div>` +
  '<script>(function(w,a,l,la,j,s){' +
  'const t=a.getElementById("walla-widget-script"); if(t) return;' +
  'j=a.createElement(l); j.async=1; j.src=la; j.id="walla-widget-script";' +
  's=a.getElementsByTagName(l)[0]||a.body; s.parentNode.insertBefore(j,s);' +
  '})(window,document,"script","https://widget.hellowalla.com/loader/v1/walla-widget-loader.js");</script>' +
  '</body></html>';

// ---------- Helpers ----------
const toISO = (v) => (v || '').toString().slice(0, 10);

async function withBrowser(fn, { dpr = 2 } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  try {
    const context = await browser.newContext({
      ...devices['Desktop Chrome'],
      deviceScaleFactor: Math.max(1, Math.min(4, Number(dpr) || 2)),
      ignoreHTTPSErrors: true,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    context.setDefaultNavigationTimeout(120000);
    context.setDefaultTimeout(90000);

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    await page.setViewportSize({ width: 1360, height: 1800 });

    // Block noisy trackers that keep long connections open
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (/\b(googletagmanager|google-analytics|doubleclick|hotjar|facebook|segment|sentry|intercom|hs-scripts)\b/i.test(u)) {
        return route.abort();
      }
      route.continue();
    });

    return await fn({ browser, context, page });
  } finally {
    await browser.close();
  }
}

// Find the widget by scanning all frames’ URLs
async function getWallaFrameByScan(page, { timeoutMs = 45000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const f = page.frames().find(fr => /widget\.hellowalla\.com/i.test(fr.url()));
    if (f) return f;
    await page.waitForTimeout(250);
  }
  throw new Error('widget_frame_not_ready');
}

async function debugDump(page) {
  const frames = page.frames().map(fr => fr.url());
  const title = await page.title().catch(() => '');
  const topHtml = await page.content().catch(() => '');
  return { frames, title, top_snippet: topHtml.slice(0, 2000) };
}

// ---------- PNG capture (optional, for audits/OCR) ----------
// GET /capture-schedule?start=YYYY-MM-DD&end=YYYY-MM-DD[&url=...][&dpr=2][&delay=1500][&fullPage=0][&debug=1]
app.get('/capture-schedule', async (req, res) => {
  const startISO = toISO(req.query.start);
  const endISO   = toISO(req.query.end);
  const dpr      = Number(req.query.dpr || 2);
  const delayMs  = Number(req.query.delay || 1500);
  const fullPage = String(req.query.fullPage || '0') === '1';
  const referer  = String(req.query.url || '');

  try {
    const pngBuffer = await withBrowser(async ({ page }) => {
      if (referer) {
        await page.goto(referer, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      } else {
        await page.setContent(LOCAL_HTML({ start: startISO, end: endISO }), {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }

      await page.waitForTimeout(delayMs); // let things paint
      const frame = await getWallaFrameByScan(page, { timeoutMs: 45000 });

      return fullPage
        ? await page.screenshot({ type: 'png', fullPage: true })
        : await frame.locator('body').screenshot({ type: 'png' });
    }, { dpr });

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Disposition', 'inline; filename="schedule.png"');
    res.setHeader('Content-Type', 'image/png');
    return res.status(200).send(pngBuffer);
  } catch (e) {
    console.error('capture-schedule failed:', e);
    if (String(req.query.debug || '0') === '1') {
      try {
        const dbg = await withBrowser(async ({ page }) => {
          if (referer) {
            await page.goto(referer, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
          } else {
            await page.setContent(LOCAL_HTML({ start: startISO, end: endISO }), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
          }
          return await debugDump(page);
        });
        return res.json({ error: 'capture_failed', details: String(e), debug: dbg });
      } catch {}
    }
    return res.status(500).json({ error: 'capture_failed', details: String(e) });
  }
});

// ---------- Text + structured rows (locks to requested day section) ----------
// GET /capture-schedule-text?start=YYYY-MM-DD&end=YYYY-MM-DD[&url=...][&debug=1]
app.get('/capture-schedule-text', async (req, res) => {
  const startISO = toISO(req.query.start);
  const endISO   = toISO(req.query.end);
  const referer  = String(req.query.url || '');
  const debug    = String(req.query.debug || '0') === '1';

  try {
    const out = await withBrowser(async ({ page }) => {
      // 1) Load real page or local shell
      if (referer) {
        await page.goto(referer, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      } else {
        await page.setContent(LOCAL_HTML({ start: startISO, end: endISO }), {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }

      // 2) Find widget frame by URL
      let frame = await getWallaFrameByScan(page, { timeoutMs: 45000 });

      // 3) Force the frame's location to include start/end (inside the frame)
      try {
        await frame.evaluate(([isoStart, isoEnd]) => {
          try {
            const u = new URL(window.location.href);
            if (isoStart) u.searchParams.set('start', isoStart);
            if (isoEnd)   u.searchParams.set('end', isoEnd);
            if (u.toString() !== window.location.href) {
              window.location.replace(u.toString());
            }
          } catch {}
        }, [startISO, endISO]);

        await page.waitForTimeout(1200);
        frame = await getWallaFrameByScan(page, { timeoutMs: 20000 });
        await page.waitForTimeout(800);
      } catch {}

      // 4) Try to ensure the proper day view is active: click "Daily" and the target day tab.
      await frame.evaluate((iso) => {
        const d = new Date(iso + 'T12:00:00');
        const dowShort = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
        const dowLong  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()];
        const monShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
        const day      = d.getUTCDate();

        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

        // Try "Daily"
        const dailyBtn = Array.from(document.querySelectorAll('button,[role=tab],a,[role=button]'))
          .find(el => /^daily$/i.test(norm(el.innerText || el.textContent || '')));
        if (dailyBtn) dailyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // Try clicking the target day tab (several label variants)
        const tabVariants = new Set([
          `${dowShort} ${monShort} ${day}`, // "Wed Sep 3"
          `${monShort} ${day}`,             // "Sep 3"
          `${dowShort} ${day}`,             // "Wed 3"
        ]);
        const tabs = Array.from(document.querySelectorAll('button,[role=tab],a,[role=button],.tab,.day'));
        for (const el of tabs) {
          const t = norm(el.innerText || el.textContent || '');
          for (const v of tabVariants) {
            if (t.includes(v)) {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              break;
            }
          }
        }
        window.scrollTo(0, 0);
      }, startISO);

      await frame.waitForTimeout(800);

      // 5) Text snapshot (debugging)
      const text = await frame.evaluate(() => document.body.innerText || '').catch(() => '');

      // 6) Parse ONLY the requested day's section
      const rows = await frame.evaluate((iso) => {
        const out = [];
        const qAll = (sel, root = document) => Array.from(root.querySelectorAll(sel));
        const txt  = (el) => (el?.innerText || '').trim();
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

        // Build labels for the date header
        const d = new Date(iso + 'T12:00:00');
        const dowLong  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()];
        const monLong  = ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()];
        const wantUpper = `${dowLong.toUpperCase()}, ${monLong.toUpperCase()} ${d.getUTCDate()}`;
        const wantCap   = `${dowLong}, ${monLong} ${d.getUTCDate()}`;

        // Find the header element for the requested day
        const headers = qAll('h1,h2,h3,h4,[role=heading],.date-header,.day-header,.schedule-day-header');
        let headerEl = headers.find(el => {
          const t = norm(txt(el));
          return t.includes(wantUpper) || t.includes(wantCap);
        });
        if (!headerEl) headerEl = headers[0];
        if (!headerEl) return out;

        // Collect nodes after headerEl until the next header
        const dayChunks = [];
        let cur = headerEl.nextElementSibling;
        while (cur) {
          const t = norm(txt(cur));
          const isAnotherHeader =
            /^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY),\s+[A-Z]+\s+\d{1,2}$/.test(t) ||
            /^[A-Z][a-z]+,\s+[A-Z][a-z]+\s+\d{1,2}$/.test(t);
          if (isAnotherHeader) break;
          dayChunks.push(cur);
          cur = cur.nextElementSibling;
        }

        const TIME_RE  = /\b([0-1]?\d:[0-5]\d)\s*([AP]M)\b/i;
        const SPOTS_RE = /\b(\d+)\s*SPOTS?\b/i;
        const IGNORE_NAME_RE = /^(EDT|[\d]+\s*min|In-?Person|Book|map|Log In|Daily|Weekly|List|Filter by|Type|Location|Instructor|Name|Category|All|The Pearl(?: Pilates Haven)?|Drop-in:|\$[\d.,]+|TIME\s+CLASS)$/i;

        function isCandidateName(s) {
          if (!s || s.length < 3) return false;
          if (TIME_RE.test(s)) return false;
          if (IGNORE_NAME_RE.test(s)) return false;
          if (/^Waitlist$/i.test(s)) return false;
          if (/^Sold\s*Out$/i.test(s)) return false;
          if (/^Full$/i.test(s)) return false;
          return true;
        }

        const candidates = [];
        for (const sect of dayChunks) {
          candidates.push(...qAll('[data-testid="class-row"], .class-row, .schedule-row, .class-item, li, tr, .row', sect));
        }
        if (candidates.length === 0) {
          for (const sect of dayChunks) candidates.push(sect);
        }

        for (const row of candidates) {
          const rowText = txt(row);
          const tm = rowText.match(TIME_RE);
          const time = tm ? `${tm[1]} ${tm[2].toUpperCase()}` : '';
          if (!time) continue;

          // Class name
          let class_name = '';
          const nameEl = row.querySelector('a, .class-title, [data-testid="class-name"], h3, h4, [role="heading"]');
          if (nameEl) class_name = txt(nameEl);
          if (!class_name) {
            const parts = rowText.split('\n').map(s => s.trim()).filter(Boolean);
            for (const p of parts) { if (isCandidateName(p)) { class_name = p; break; } }
          }

          // Instructor (e.g., "w/ Ana Maria")
          let instructor = '';
          const im = rowText.match(/w\/\s*([A-Za-z][A-Za-z .'-]+)/i);
          if (im) instructor = im[1].trim();

          // Spots badge or button text
          const badges = qAll('span, div, button', row).map(txt);
          const spotsLabel = badges.find(t => SPOTS_RE.test(t));
          const btnText    = badges.find(t => /book|waitlist|sold\s*out|full/i.test(t)) || '';

          let open_spots = null;
          let status = 'unknown';

          if (spotsLabel) {
            const m = spotsLabel.match(SPOTS_RE);
            open_spots = m ? parseInt(m[1], 10) : 0;
            status = open_spots > 0 ? 'open' : 'full';
          }
          if (/waitlist/i.test(btnText) || /waitlist/i.test(rowText)) {
            status = 'waitlist';
            if (open_spots === null) open_spots = 0;
          } else if (/sold\s*out|^full$/i.test(btnText)) {
            status = 'full';
            if (open_spots === null) open_spots = 0;
          } else if (/book/i.test(btnText) && open_spots === null) {
            // "Book" without numeric badge -> open but unknown count
            status = 'open';
            open_spots = null;
          }

          if (time && (class_name || status !== 'unknown')) {
            out.push({
              date: iso || '',
              time,
              class_name: class_name || '',
              instructor: instructor || '',
              status,
              open_spots, // number | null
            });
          }
        }

        // Deduplicate
        const seen = new Set();
        const dedup = [];
        for (const r of out) {
          const key = `${r.date}|${r.time}|${r.class_name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          dedup.push(r);
        }
        return dedup;
      }, startISO).catch(() => []);

      // Also report frame URLs for quick debugging
      const frames = page.frames().map(fr => fr.url());

      return { text, parsed: rows, frames };
    });

    return res.json({ start: startISO, end: endISO, ...out });
  } catch (e) {
    console.error('capture-schedule-text failed:', e);
    if (debug) return res.json({ error: 'text_capture_failed', details: String(e) });
    return res.status(500).json({ error: 'text_capture_failed', details: String(e) });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('walla-capture listening on ' + PORT));
