// server.js
// Run: node server.js
// One-time: npx playwright install --with-deps
// package.json should include: { "type": "module" }

import express from 'express';
import cors from 'cors';
import { chromium, devices } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- Health ----------
app.get('/healthz', (_req, res) => res.send('ok'));

// ---------- Auth (optional via SCRAPER_TOKEN) ----------
app.use((req, res, next) => {
  const AUTH_TOKEN = process.env.SCRAPER_TOKEN || '';
  if (!AUTH_TOKEN) return next();
  const token = req.get('x-api-key') || req.query.key;
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// ---------- Widget identity ----------
const WALLA_UUID = process.env.WALLA_UUID || '3f4c5689-8468-47d5-a722-c0ab605b2da4';
const WALLA_LOCATION_ID = process.env.WALLA_LOCATION_ID || '3589';

// ---------- Local HTML shell to host the widget ----------
const LOCAL_HTML = ({ start, end }) =>
  '<!doctype html><html><head><meta charset="utf-8"/></head><body>' +
  '<div class="walla-widget-root" ' +
  `data-walla-id="${WALLA_UUID}" data-walla-page="classes" ` +
  `data-walla-locationid="${WALLA_LOCATION_ID}" ` +
  `data-start="${start || ''}" data-end="${end || ''}"></div>` +
  '<script>(function(w,a,l,la,j,s){' +
  'const t=a.getElementById("walla-widget-script"); if(t) return;' +
  'j=a.createElement(l); j.async=1; j.src=la; j.id="walla-widget-script";' +
  's=a.getElementsByTagName(l)[0]||a.body; s.parentNode.insertBefore(j,s);' +
  '})(window,document,"script","https://widget.hellowalla.com/loader/v1/walla-widget-loader.js");</script>' +
  '</body></html>';

// ---------- Helpers ----------
const pickISO = (v) => {
  const m = String(v || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
};
const toISO = (v) => pickISO(v);

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

    // Block some trackers that keep long connections
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

async function getWallaFrameByScan(page, { timeoutMs = 45000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const f = page.frames().find(fr => /widget\.hellowalla\.com/i.test(fr.url()));
    if (f) return f;
    await page.waitForTimeout(200);
  }
  throw new Error('widget_frame_not_ready');
}

// -------- Visible date extraction (trust iframe URL first) --------
async function extractVisibleDateISO(frame, targetYear) {
  return await frame.evaluate((year) => {
    const pickISO = (v) => {
      const m = String(v || '').match(/(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };
    // 1) Canonical: iframe URL ?start=YYYY-MM-DD
    try {
      const u = new URL(location.href);
      const s = pickISO(u.searchParams.get('start'));
      if (s) return s;
    } catch {}

    // 2) Fallback: scan headings/body like "WEDNESDAY, SEPTEMBER 3"
    const MONTHS = {
      JANUARY:1,FEBRUARY:2,MARCH:3,APRIL:4,MAY:5,JUNE:6,JULY:7,AUGUST:8,SEPTEMBER:9,OCTOBER:10,NOVEMBER:11,DECEMBER:12
    };
    function norm(s){ return (s||'').replace(/\s+/g,' ').trim(); }

    const headers = Array.from(document.querySelectorAll('h1,h2,h3,h4,[role=heading],.date-header,.day-header,.schedule-day-header,.walla-date,.day-title'))
      .map(el => norm(el.innerText||el.textContent||''))
      .filter(Boolean);

    for (const t of headers) {
      const m = t.match(/^(?:SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY),?\s+([A-Z]+)\s+(\d{1,2})$/i);
      if (m) {
        const map = MONTHS;
        const monthName = m[1].toUpperCase();
        const day = parseInt(m[2],10);
        const month = map[monthName];
        if (month && day >= 1 && day <= 31) {
          const mm = String(month).padStart(2,'0');
          const dd = String(day).padStart(2,'0');
          return `${year}-${mm}-${dd}`;
        }
      }
    }
    const body = norm(document.body.innerText||'');
    const m2 = body.match(/(?:SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY),?\s+([A-Z]+)\s+(\d{1,2})/i);
    if (m2) {
      const map = MONTHS;
      const monthName = m2[1].toUpperCase();
      const day = parseInt(m2[2],10);
      const month = map[monthName];
      if (month && day>=1 && day<=31) {
        const mm = String(month).padStart(2,'0');
        const dd = String(day).padStart(2,'0');
        return `${year}-${mm}-${dd}`;
      }
    }
    return null;
  }, (new Date().getFullYear()));
}

// -------- Plain-text (day-scoped) parser with price & spots --------
function parseFromPlainText(text, iso) {
  if (!text) return [];

  const d = new Date(iso + 'T12:00:00Z');
  const dowLong = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()];
  const monLong = ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()];
  const monShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  const day = d.getUTCDate();

  const headerUpper = `${dowLong.toUpperCase()}, ${monLong.toUpperCase()} ${day}`;
  const headerCap   = `${dowLong}, ${monLong} ${day}`;
  const tabShort    = `${monShort} ${day}`;

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  let startIdx = lines.findIndex(l => {
    const t = norm(l);
    return t.includes(headerUpper) || t.includes(headerCap) || t.includes(tabShort);
  });
  if (startIdx < 0) startIdx = 0;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = norm(lines[i]);
    if (/^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY),\s+[A-Z]+\s+\d{1,2}$/.test(t) ||
        /^[A-Z][a-z]+,\s+[A-Z][a-z]+\s+\d{1,2}$/.test(t)) {
      endIdx = i; break;
    }
  }

  const section = lines.slice(startIdx, endIdx);

  const TIME_RE   = /^([0-1]?\d:[0-5]\d)\s*([AP]M)$/i;
  const PRICE_RE  = /(?:Drop-?in:?\s*)?\$([0-9]+(?:\.[0-9]{2})?)/i;
  const SPOTS_RE  = /^(\d+)\s*SPOTS?$/i;
  const DROPIN_RE = /^Drop-?in:\s*\$\d[\d.,]*/i;

  const IGNORE = new Set(['EDT','In-Person','Book','map','Log In','Daily','Weekly','List','Filter by','Type','Location','Instructor','Name','Category','All','The Pearl','The Pearl Pilates Haven']);

  const rows = [];
  let cur = null;

  function pushCur() {
    if (!cur) return;
    if (cur.time && (cur.class_name || cur.status !== 'unknown')) {
      rows.push({
        date: iso,
        time: cur.time,
        class_name: cur.class_name || '',
        instructor: cur.instructor || '',
        status: cur.status,
        open_spots: cur.open_spots,
        price: cur.price,
        price_text: cur.price_text
      });
    }
    cur = null;
  }

  for (let i = 0; i < section.length; i++) {
    const raw = section[i];
    const t = norm(raw);

    const tm = t.match(TIME_RE);
    if (tm) {
      pushCur();
      cur = { time: `${tm[1]} ${tm[2].toUpperCase()}`, class_name: '', instructor: '', status: 'unknown', open_spots: null, price: null, price_text: null };
      continue;
    }
    if (!cur) continue;

    const pm = t.match(PRICE_RE);
    if (pm) {
      cur.price = parseFloat(pm[1]);
      cur.price_text = `$${pm[1]}`;
    }

    if (IGNORE.has(t)) continue;
    if (DROPIN_RE.test(t)) continue;

    const im = t.match(/^w\/\s*([A-Za-z][A-Za-z .'-]+)/i);
    if (im) { cur.instructor = im[1].trim(); continue; }

    if (/^Waitlist$/i.test(t)) { cur.status = 'waitlist'; cur.open_spots = 0; continue; }
    if (/^Sold\s*Out$/i.test(t) || /^Full$/i.test(t)) { cur.status = 'full'; cur.open_spots = 0; continue; }
    const sp = t.match(SPOTS_RE);
    if (sp) { const n = parseInt(sp[1], 10); cur.open_spots = n; cur.status = n > 0 ? 'open' : 'full'; continue; }
    if (/^Book$/i.test(t)) { if (cur.open_spots == null) cur.status = 'open'; continue; }

    if (!cur.class_name && t.length >= 3 && !DROPIN_RE.test(t)) {
      cur.class_name = t;
    }
  }
  pushCur();

  // Dedup
  const seen = new Set();
  const dedup = [];
  for (const r of rows) {
    const key = `${r.date}|${r.time}|${r.class_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(r);
  }
  return dedup;
}

// ---------- PNG capture (optional) ----------
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
        await page.setContent(LOCAL_HTML({ start: startISO, end: endISO }), { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      await page.waitForTimeout(delayMs);
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
    return res.status(500).json({ error: 'capture_failed', details: String(e) });
  }
});

// ---------- Text + structured rows (TEXT-FIRST + DOM fallback) ----------
app.get('/capture-schedule-text', async (req, res) => {
  const startISO = toISO(req.query.start);
  const endISO   = toISO(req.query.end);
  const referer  = String(req.query.url || '');
  const debug    = String(req.query.debug || '0') === '1';
  const delayMs  = Number(req.query.delay || 2000);

  try {
    const result = await withBrowser(async ({ page }) => {
      // Load page or local shell
      if (referer) {
        await page.goto(referer, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      } else {
        await page.setContent(LOCAL_HTML({ start: startISO, end: endISO }), { waitUntil: 'domcontentloaded', timeout: 60000 });
      }

      // Find widget frame
      let frame = await getWallaFrameByScan(page, { timeoutMs: 45000 });

      // Force frame to start/end via URL
      try {
        await frame.evaluate(([isoStart, isoEnd]) => {
          try {
            const u = new URL(window.location.href);
            if (isoStart) u.searchParams.set('start', isoStart);
            if (isoEnd)   u.searchParams.set('end', isoEnd);
            if (u.toString() !== window.location.href) window.location.replace(u.toString());
          } catch {}
        }, [startISO, endISO]);

        // give it a moment to reload and re-acquire the frame
        await page.waitForTimeout(1200);
        frame = await getWallaFrameByScan(page, { timeoutMs: 20000 });

        // ensure the frame URL actually has the requested start date
        await frame.waitForFunction((iso) => {
          try { return new URL(location.href).searchParams.get('start') === iso; }
          catch { return false; }
        }, startISO, { timeout: 5000 }).catch(() => {});
      } catch {}

      // Try toggling to "Daily" + click the target day tab
      await frame.evaluate((iso) => {
        const d = new Date(iso + 'T12:00:00');
        const dowShort = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
        const monShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
        const day = d.getUTCDate();
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

        const dailyBtn = Array.from(document.querySelectorAll('button,[role=tab],a,[role=button]'))
          .find(el => /^daily$/i.test(norm(el.innerText || el.textContent || '')));
        if (dailyBtn) dailyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        const tabVariants = new Set([`${dowShort} ${monShort} ${day}`, `${monShort} ${day}`, `${dowShort} ${day}`]);
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
      }, startISO).catch(()=>{});

      // Waits: layout + content present
      await frame.waitForTimeout(delayMs);
      await frame.waitForFunction(() => {
        const t = (document.body.innerText || '').trim();
        return /\b([0-1]?\d:[0-5]\d)\s*(AM|PM)\b/i.test(t) || /Book|Waitlist|Sold\s*Out|Full/i.test(t);
      }, { timeout: 20000 }).catch(()=>{});

      // Snapshot text for day-scoped parsing
      const text = await frame.evaluate(() => document.body.innerText || '').catch(() => '');

      // --- TEXT-FIRST ---
      let parse_mode = 'text';
      let parsed = parseFromPlainText(text, startISO);

      // --- DOM fallback (global) if text empty ---
      if (!parsed || parsed.length === 0) {
        parse_mode = 'global-dom';
        parsed = await frame.evaluate((iso) => {
          const out = [];
          const qAll = (sel, r = document) => Array.from(r.querySelectorAll(sel));
          const txt  = (el) => (el?.innerText || '').trim();

          const TIME_RE   = /\b([0-1]?\d:[0-5]\d)\s*([AP]M)\b/i;
          const SPOTS_RE  = /\b(\d+)\s*SPOTS?\b/i;
          const PRICE_RE  = /(?:Drop-?in:?\s*)?\$([0-9]+(?:\.[0-9]{2})?)/i;

          const cands = qAll('[data-testid="class-row"], .class-row, .schedule-row, .class-item, li, tr, .row')
            .filter(el => (el && (el.innerText || '').trim().length > 0));

          for (const row of cands) {
            const t = txt(row);
            const tm = t.match(TIME_RE);
            if (!tm) continue;
            const time = `${tm[1]} ${tm[2].toUpperCase()}`;

            let class_name = (row.querySelector('.class-title,[data-testid="class-name"],a,h3,h4,[role=heading]')?.innerText || '').trim();
            if (!class_name) {
              const parts = t.split('\n').map(s => s.trim()).filter(Boolean);
              class_name = parts.find(p => !TIME_RE.test(p) && !/^Drop-?in:/i.test(p) && p.length > 2 && !/^EDT$/i.test(p)) || '';
            }

            let instructor = '';
            const im = t.match(/w\/\s*([A-Za-z][A-Za-z .'-]+)/i);
            if (im) instructor = im[1].trim();

            const badges = qAll('span, div, button', row).map(e => (e.innerText || '').trim());
            const spotsLabel = badges.find(s => SPOTS_RE.test(s));
            const btnText    = badges.find(s => /book|waitlist|sold\s*out|full/i.test(s)) || '';

            // price
            let price = null, price_text = null;
            const pRow = t.match(PRICE_RE);
            if (pRow) { price = parseFloat(pRow[1]); price_text = `$${pRow[1]}`; }
            if (price == null) {
              const pBadge = badges.map(b => b.match(PRICE_RE)).find(Boolean);
              if (pBadge) { price = parseFloat(pBadge[1]); price_text = `$${pBadge[1]}`; }
            }

            let open_spots = null; let status = 'unknown';
            if (spotsLabel) { const m = spotsLabel.match(SPOTS_RE); open_spots = m ? parseInt(m[1], 10) : 0; status = open_spots > 0 ? 'open' : 'full'; }
            if (/waitlist/i.test(btnText) || /waitlist/i.test(t)) { status = 'waitlist'; if (open_spots === null) open_spots = 0; }
            else if (/sold\s*out|^full$/i.test(btnText)) { status = 'full'; if (open_spots === null) open_spots = 0; }
            else if (/book/i.test(btnText) && open_spots === null) { status = 'open'; open_spots = null; }

            out.push({ date: iso, time, class_name, instructor, status, open_spots, price, price_text });
          }

          // Dedup
          const seen = new Set(); const dedup = [];
          for (const r of out) { const k = `${r.date}|${r.time}|${r.class_name}`; if (seen.has(k)) continue; seen.add(k); dedup.push(r); }
          return dedup;
        }, startISO).catch(() => []);
      }

      // Visible date + mismatch flag
      const visibleISO = await extractVisibleDateISO(frame, (new Date().getFullYear())).catch(() => null);
      const day_mismatch = !!(visibleISO && startISO && visibleISO !== startISO);

      return {
        parsed,
        parse_mode,
        visible_date_iso: visibleISO || null,
        day_mismatch,
        text: debug ? text : undefined,
        frames: debug ? page.frames().map(fr => fr.url()) : undefined
      };
    });

    return res.json({
      start: startISO,
      end: endISO,
      parse_mode: result.parse_mode || null,
      visible_date_iso: result.visible_date_iso || null,
      day_mismatch: result.day_mismatch || false,
      parsed: result.parsed || [],
      ...(debug ? { text: result.text || '', frames: result.frames || [] } : {}),
    });
  } catch (e) {
    console.error('capture-schedule-text failed:', e);
    if (debug) return res.json({ parse_mode: null, parsed: [], error: 'text_capture_failed', details: String(e) });
    return res.status(500).json({ error: 'text_capture_failed', details: String(e) });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('walla-capture listening on ' + PORT));
