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
      capacity: cap,
      booked,
      open_spots: open,
      waitlist_count: Number(c.waitlist ?? c.waitlistCount ?? 0),
      has_open_spots: open > 0,
    };
  });
}

// ---------- Summary helper (NY timezone) ----------
function summarizeClassesNY(list = []) {
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
    const d = c.start_time ? new Date(c.start_time) : null;
    const mmddyyyy = d ? fmtDate.format(d) : '';
    const date = mmddyyyy.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2'); // -> YYYY-MM-DD
    const time = d ? fmtTime.format(d) : '';
    return {
      date,          // "YYYY-MM-DD"
      time,          // "h:mm AM/PM"
      open_spots: c.open_spots ?? 0,
      class_name: c.class_name ?? '',
      instructor: c.instructor ?? '',
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

// ---------- Main endpoint: /scrape-classes ----------
app.get('/scrape-classes', async (req, res) => {
  const { start, end, url, debug } = req.query;
  const format = String(req.query.format || 'json');       // 'json' | 'summary'
  const onlyOpen = String(req.query.onlyOpen || '0') === '1';

  const startISO = toISODateStr(start);
  const endISO = toISODateStr(end);
  const referer = String(url || 'https://www.pearlmovement.com/cityislandschedule');

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

      // capture ONLY the widget classes payload
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

      // navigate to real page or local shell
      if (url) {
        await page.goto(referer, { waitUntil: 'networkidle', timeout: 60000 });
      } else {
        await page.setContent(LOCAL_HTML({ start: startISO, end: endISO }), {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        // ensure loader exists (LOCAL_HTML already injects it)
        try {
          await page.addScriptTag({
            url: 'https://widget.hellowalla.com/loader/v1/walla-widget-loader.js',
          });
        } catch { /* ignore */ }
      }

      // wait for widget presence, then give network time
      try {
        await page.waitForSelector(
          'iframe[src*="hellowalla"], [data-walla-page="classes"]',
          { timeout: 20000 }
        );
      } catch { /* ignore */ }

      await page.waitForTimeout(3000);
      if (!classesJson) await page.waitForTimeout(4000);

      // ----- Direct-API fallback (derive uuid/locationId from DOM or env) -----
      async function directFetchFromDom() {
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

        const uuid = meta.uuid || process.env.WALLA_UUID || '';
        const locationId = meta.locationId || process.env.WALLA_LOCATION_ID || '';
        const s = startISO || meta.start || '';
        const e = endISO || meta.end || '';

        if (!uuid || !locationId) return null;

        const apiUrl =
          `https://${targetHost}${targetPath}?` +
          `uuid=${encodeURIComponent(uuid)}&locationId=${encodeURIComponent(locationId)}` +
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

      if (!classesJson) {
        try { classesJson = await directFetchFromDom(); } catch { /* ignore */ }
      }

      // Optional debug snapshot when still empty
      if ((!classesJson || !Array.isArray(classesJson)) && debug) {
        const title = (await page.title().catch(() => '')) || '';
        const html = (await page.content().catch(() => '')) || '';
        return { debug: { title, sample: html.slice(0, 2000) }, classes: [] };
      }

      return { classes: normalize(classesJson || []) };
    });

    // ---------- ALWAYS return an array (this is the important safety fix) ----------
    let rows = Array.isArray(result.classes) ? result.classes : [];

    // Filtering & formatting options
    if (onlyOpen) rows = rows.filter((r) => (r.open_spots || 0) > 0);

    if (result.debug) {
      // When debugging, still keep classes as an array
      return res.json({
        start: startISO,
        end: endISO,
        count: 0,
        classes: [],
        debug: result.debug,
      });
    }

    if (format === 'summary') {
      const summary = summarizeClassesNY(rows);
      return res.json({ count: summary.length, classes: summary });
    }

    // default: full JSON
    return res.json({
      start: startISO,
      end: endISO,
      count: rows.length,
      classes: rows,
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
