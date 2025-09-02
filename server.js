// server.js
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
  if (!AUTH_TOKEN) return next();
  const token = req.get('x-api-key') || req.query.key;
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// ---------- Local HTML shell for the widget (used when no ?url= is provided) ----------
const LOCAL_HTML = ({ start, end }) =>
  '<!doctype html><html><head><meta charset="utf-8"/></head><body>' +
  '<div class="walla-widget-root" ' +
  'data-walla-id="3f4c5689-8468-47d5-a722-c0ab605b2da4" ' + // set yours if different
  'data-walla-page="classes" ' +
  'data-walla-locationid="3589" ' + // set yours if different
  `data-start="${start || ''}" ` +
  `data-end="${end || ''}"></div>` +
  '<script>(function(w,a,l,la,j,s){' +
  'const t=a.getElementById("walla-widget-script"); if(t) return;' +
  'j=a.createElement(l); j.async=1; j.src=la; j.id="walla-widget-script";' +
  's=a.getElementsByTagName(l)[0]||a.body; s.parentNode.insertBefore(j,s);' +
  '})(window,document,"script","https://widget.hellowalla.com/loader/v1/walla-widget-loader.js");</script>' +
  '</body></html>';

// ---------- Normalize Walla classes payload into a stable shape ----------
function normalize(list = []) {
  return list.map((c) => {
    const cap = Number(c.capacity ?? c.maxCapacity ?? 0);
    const booked = Number(c.booked ?? c.bookedCount ?? c.enrolled ?? 0);
    const open = Math.max(cap - booked, 0);
    return {
      class_id: c.id ?? c.classId ?? null,
      class_name: c.name ?? c.className ?? '',
      instructor: c?.instructor?.name ?? c.instructor ?? '',
      start_time: c.start ?? c.startTime ?? null,
      end_time: c.end ?? c.endTime ?? null,
      room: c.room ?? c.roomName ?? '',
      location_id: c.locationId ?? 3589,
      capacity: cap || null,
      booked: booked || null,
      open_spots: open || 0,
      waitlist_count: Number(c.waitlist ?? c.waitlistCount ?? 0) || null,
      has_open_spots: open > 0,
      status: open > 0 ? 'open' : (cap ? 'full' : 'unknown'),
    };
  });
}

// ---------- Summary helper (NY timezone) ----------
function summarizeClassesNY(list = [], defaultDateISO = '') {
  const fmtDate = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const fmtTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });

  return list.map((c) => {
    const d = c.start_time ? new Date(c.start_time) : (defaultDateISO ? new Date(defaultDateISO) : null);
    const mmddyyyy = d ? fmtDate.format(d) : '';
    const date = mmddyyyy ? mmddyyyy.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2') : (defaultDateISO || '');
    const time = c.time || (d ? fmtTime.format(d) : '');
    return {
      date,          // "YYYY-MM-DD"
      time,          // "h:mm AM/PM"
      open_spots: c.open_spots ?? 0,
      class_name: c.class_name ?? '',
      instructor: c.instructor ?? '',
      status: c.status ?? undefined,
    };
  });
}

// ---------- Playwright launcher ----------
async function withBrowser(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // optional flags that can help with cross-origin frames
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  try {
    const context = await browser.newContext({
      ...devices['Desktop Chrome'],
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    // reduce automation fingerprints
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    return await fn({ browser, context, page });
  } finally {
    await browser.close();
  }
}

// ---------- Utils ----------
const toISODateStr = (v) => (v || '').toString().slice(0, 10);

async function getWidgetFrame(page) {
  const iframeEl = await page.waitForSelector('iframe[src*="widget.hellowalla.com"]', { timeout: 30000 });
  const frame = await iframeEl.contentFrame();
  return frame;
}

// ---------- Inspect widget API fields (optional helper) ----------
app.get('/inspect-widget', async (req, res) => {
  const start = toISODateStr(req.query.start);
  const end   = toISODateStr(req.query.end);
  const uuid  = req.query.uuid || process.env.WALLA_UUID || '3f4c5689-8468-47d5-a722-c0ab605b2da4';
  const locationId = req.query.locationId || process.env.WALLA_LOCATION_ID || '3589';

  const url = `https://widget.hellowalla.com/api/classes?uuid=${encodeURIComponent(uuid)}&locationId=${encodeURIComponent(locationId)}${start?`&start=${start}`:''}${end?`&end=${end}`:''}`;
  try {
    const r = await fetch(url, { headers: { 'Accept':'application/json' }});
    const data = await r.json().catch(()=>[]);
    const rows = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    const keys = [...new Set(rows.flatMap(o => Object.keys(o||{})))].sort();
    res.json({ count: rows.length, keys, sample: rows.slice(0,3) });
  } catch (e) {
    res.status(500).json({ error: 'inspect_failed', details: String(e) });
  }
});

// ---------- Main endpoint: /scrape-classes ----------
app.get('/scrape-classes', async (req, res) => {
  const {
    start, end, url, debug,
    mode,                // 'json' (default) | 'direct' | 'dom'
    uuid: qUuid,         // optional override
    locationId: qLoc,    // optional override
  } = req.query;

  const format   = String(req.query.format || 'json');   // 'json' | 'summary'
  const onlyOpen = String(req.query.onlyOpen || '0') === '1';

  const startISO = toISODateStr(start);
  const endISO   = toISODateStr(end);
  const referer  = String(url || 'https://www.pearlmovement.com/cityislandschedule');

  const targetHost = 'widget.hellowalla.com';
  const targetPath = '/api/classes';

  try {
    const result = await withBrowser(async ({ context, page }) => {
      // realistic headers
      await context.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
        'Referer': referer,
      });

      // Navigate to real page or local shell
      if (url) {
        await page.goto(referer, { waitUntil: 'networkidle', timeout: 60000 });
      } else {
        await page.setContent(LOCAL_HTML({ start: startISO, end: endISO }), {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        try {
          await page.addScriptTag({ url: 'https://widget.hellowalla.com/loader/v1/walla-widget-loader.js' });
        } catch { /* ignore */ }
      }

      // Wait for widget presence
      try {
        await page.waitForSelector('iframe[src*="hellowalla"], [data-walla-page="classes"]', { timeout: 20000 });
      } catch { /* ignore */ }

      // ---------- MODE: DOM (read badges/buttons from rendered UI) ----------
      if (mode === 'dom') {
        const frame = await getWidgetFrame(page);

        const rows = await frame.evaluate((defaultDate) => {
          const out = [];
          const qAll = (sel, root = document) => Array.from(root.querySelectorAll(sel));
          const txt = (el) => (el?.innerText || '').trim();

          // Iterate likely "row" containers to avoid duplicates
          const candidates = qAll('[data-testid="class-row"], .class-row, .schedule-row, li, tr, .row, .class-item, .list-item')
            .filter(el => txt(el).length > 0);

          for (const row of candidates) {
            const rowText = txt(row);

            // Time like "8:15 AM"
            const tm = rowText.match(/\b([0-1]?\d:[0-5]\d)\s*([AP]M)\b/i);
            const time = tm ? `${tm[1]} ${tm[2].toUpperCase()}` : '';

            // Class name
            const nameEl = row.querySelector('a, .class-title, [data-testid="class-name"], h3, h4');
            let class_name = txt(nameEl);
            if (!class_name) {
              const firstLine = rowText.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
              class_name = firstLine;
            }

            // Instructor (pattern "w/ Ana Maria")
            let instructor = '';
            const im = rowText.match(/w\/\s*([A-Za-z][A-Za-z .'-]+)/i);
            if (im) instructor = im[1];

            // Spots badge (e.g., "2 SPOTS", "1 SPOT", "0 SPOTS")
            const spotLabel = qAll('span, div', row).map(txt).find(t => /\b\d+\s*SPOTS?\b/i.test(t));
            let open_spots = null;
            if (spotLabel) {
              const m = spotLabel.match(/(\d+)\s*SPOTS?/i);
              open_spots = m ? parseInt(m[1], 10) : 0;
            }

            // Action button text (e.g., "Book", "Waitlist", "Sold Out", "Full")
            const btn = row.querySelector('button');
            const btnText = txt(btn);

            // Determine status
            let status = 'unknown';
            if (/waitlist/i.test(btnText) || /waitlist/i.test(rowText)) {
              status = 'waitlist';
              if (open_spots === null) open_spots = 0;
            } else if (open_spots !== null) {
              status = open_spots > 0 ? 'open' : 'full';
            } else if (/book/i.test(btnText)) {
              status = 'open';
            } else if (/sold\s*out|full/i.test(btnText + ' ' + rowText)) {
              status = 'full';
              open_spots = 0;
            }

            // Only keep rows that look like legit classes (time or name present)
            if (!time && !class_name) continue;

            out.push({
              class_id: null,
              class_name,
              instructor,
              start_time: null,
              end_time: null,
              date: defaultDate || '',
              time,
              room: '',
              location_id: 3589,
              capacity: null,
              booked: null,
              open_spots: open_spots ?? 0,
              waitlist_count: null,
              has_open_spots: (open_spots ?? 0) > 0,
              status, // 'open' | 'full' | 'waitlist' | 'unknown'
            });
          }

          // Deduplicate by (date|time|class_name)
          const seen = new Set();
          const dedup = [];
          for (const r of out) {
            const key = `${r.date}|${r.time}|${r.class_name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            dedup.push(r);
          }
          return dedup;
        }, startISO);

        // Keep keys consistent with normalize() where possible
        return { classes: rows, mode: 'dom' };
      }

      // ---------- MODE: JSON (listen for /api/classes) ----------
      let classesJson = null;

      page.on('response', async (r) => {
        try {
          const u = new URL(r.url());
          if (u.hostname !== targetHost) return;
          if (!u.pathname.includes(targetPath)) return;

          const ct = (r.headers()['content-type'] || '').toLowerCase();
          if (!ct.includes('application/json')) return;

          const data = await r.json();
          classesJson = Array.isArray(data)
            ? data
            : Array.isArray(data?.data)
              ? data.data
              : null;
        } catch { /* ignore */ }
      });

      // Give the network listener time to catch the JSON
      await page.waitForTimeout(3000);
      if (!classesJson) await page.waitForTimeout(4000);

      // ---------- MODE: DIRECT (or fallback for JSON mode) ----------
      async function directFetch(uuidOverride, locOverride) {
        let uuid = uuidOverride || process.env.WALLA_UUID || '';
        let locationId = locOverride || process.env.WALLA_LOCATION_ID || '';

        // If still missing, try to discover from DOM
        if (!uuid || !locationId) {
          const meta = await page.evaluate(() => {
            const out = {};
            const nodes = Array.from(document.querySelectorAll('script[src],iframe[src]'));
            for (const el of nodes) {
              const s = el.getAttribute('src');
              if (!s || !s.includes('widget.hellowalla.com')) continue;
              try {
                const u = new URL(s, location.href);
                for (const [k, v] of u.searchParams.entries()) {
                  if (!out.uuid && /uuid/i.test(k)) out.uuid = v;
                  if (!out.locationId && /locationid/i.test(k)) out.locationId = v;
                  if (!out.start && /start/i.test(k)) out.start = v;
                  if (!out.end && /end/i.test(k)) out.end = v;
                }
              } catch {}
            }
            const root = document.querySelector('[data-walla-id],[data-walla-locationid]');
            if (root) {
              if (!out.uuid) out.uuid = root.getAttribute('data-walla-id') || out.uuid;
              if (!out.locationId) out.locationId = root.getAttribute('data-walla-locationid') || out.locationId;
              if (!out.start) out.start = root.getAttribute('data-start') || out.start;
              if (!out.end) out.end = root.getAttribute('data-end') || out.end;
            }
            return out;
          });
          uuid       = uuid       || meta.uuid || '';
          locationId = locationId || meta.locationId || '';
        }

        const s = startISO || '';
        const e = endISO   || '';
        if (!uuid || !locationId) return null;

        const apiUrl =
          `https://${targetHost}${targetPath}?uuid=${encodeURIComponent(uuid)}&locationId=${encodeURIComponent(locationId)}` +
          (s ? `&start=${encodeURIComponent(s)}` : '') +
          (e ? `&end=${encodeURIComponent(e)}` : '');

        const r = await fetch(apiUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': referer,
          },
        });
        if (!r.ok) return null;
        const data = await r.json();
        return Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
      }

      if (mode === 'direct' || (!classesJson)) {
        try { classesJson = await directFetch(qUuid, qLoc); } catch { /* ignore */ }
      }

      // Optional debug snapshot when still empty
      if ((!classesJson || !Array.isArray(classesJson)) && debug) {
        const title = (await page.title().catch(() => '')) || '';
        const html  = (await page.content().catch(() => '')) || '';
        return { debug: { title, sample: html.slice(0, 2000) }, classes: [], mode: mode || 'json' };
      }

      return { classes: normalize(classesJson || []), mode: mode || 'json' };
    });

    // ---------- ALWAYS return an array (safety) ----------
    let rows = Array.isArray(result.classes) ? result.classes : [];

    // optional filtering
    if (onlyOpen) rows = rows.filter((r) => (r.open_spots || 0) > 0);

    if (result.debug) {
      return res.json({
        start: startISO,
        end: endISO,
        count: 0,
        classes: [],
        debug: result.debug,
        mode: result.mode || 'json',
      });
    }

    if (format === 'summary') {
      // In DOM mode, we already filled date/time; use startISO as default date
      const summary = summarizeClassesNY(rows, startISO);
      return res.json({ count: summary.length, classes: summary, mode: result.mode || 'json' });
    }

    // default: full JSON
    return res.json({
      start: startISO,
      end: endISO,
      count: rows.length,
      classes: rows,
      mode: result.mode || 'json',
    });

  } catch (e) {
    console.error('scrape-classes failed:', e);
    return res.status(500).json({ error: 'navigation_failed', details: String(e) });
  }
});

// ---------- Global error handler ----------
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error', details: String(err) });
});

// ---------- Start ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('walla-scraper listening on ' + PORT));
