// server.js
import express from 'express';
import cors from 'cors';
import { chromium, devices } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Simple healthcheck
app.get('/healthz', (_req, res) => res.send('ok'));

// Auth middleware (x-api-key or ?key=... must match SCRAPER_TOKEN if set)
app.use((req, res, next) => {
  const AUTH_TOKEN = process.env.SCRAPER_TOKEN || '';
  if (!AUTH_TOKEN) return next();
  const token = req.get('x-api-key') || req.query.key;
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// Minimal HTML shell to host the Walla widget when `url` isn't provided
const LOCAL_HTML = ({ start, end }) =>
  '<!doctype html><html><head><meta charset="utf-8"/></head><body>' +
  '<div class="walla-widget-root" ' +
  'data-walla-id="3f4c5689-8468-47d5-a722-c0ab605b2da4" ' + // <-- set yours if different
  'data-walla-page="classes" ' +
  'data-walla-locationid="3589" ' + // <-- set yours if different
  'data-start="' + (start || '') + '" ' +
  'data-end="' + (end || '') + '"></div>' +
  '<script>(function(w,a,l,la,j,s){' +
  'const t=a.getElementById("walla-widget-script"); if(t) return;' +
  'j=a.createElement(l); j.async=1; j.src=la; j.id="walla-widget-script";' +
  's=a.getElementsByTagName(l)[0]||a.body; s.parentNode.insertBefore(j,s);' +
  '})(window,document,"script","https://widget.hellowalla.com/loader/v1/walla-widget-loader.js");</script>' +
  '</body></html>';

// Normalize the classes payload into a consistent shape
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

// Launch Playwright with a realistic device & environment
async function withBrowser(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // The following flags are optional; can help with cross-origin frames:
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

    // Reduce automation fingerprints
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    return await fn({ browser, context, page });
  } finally {
    await browser.close();
  }
}

// Helper to coerce to YYYY-MM-DD
function toISODateStr(v) {
  return (v || '').toString().slice(0, 10);
}

// Main endpoint: scrape classes via Playwright, with direct-API fallback
app.get('/scrape-classes', async (req, res) => {
  const { start, end, url, debug } = req.query;

  const startISO = toISODateStr(start);
  const endISO = toISODateStr(end);
  const referer = String(url || 'https://www.pearlmovement.com/cityislandschedule');

  const targetHost = 'widget.hellowalla.com';
  const targetPath = '/api/classes';

  try {
    const result = await withBrowser(async ({ context, page }) => {
      // Realistic headers to reduce soft bot-blocks
      await context.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
        Referer: referer,
      });

      // Capture ONLY the Walla classes endpoint
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
        } catch {
          /* ignore */
        }
      });

      // Navigate either to a real page or a local shell that loads the widget
      if (url) {
        await page.goto(referer, { waitUntil: 'networkidle', timeout: 60000 });
      } else {
        await page.setContent(LOCAL_HTML({ start: startISO, end: endISO }), {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        // Ensure loader; LOCAL_HTML already injects it, this is just redundant/harmless
        try {
          await page.addScriptTag({
            url: 'https://widget.hellowalla.com/loader/v1/walla-widget-loader.js',
          });
        } catch {
          /* ignore */
        }
      }

      // Try to ensure the widget is present/rendered
      try {
        await page.waitForSelector(
          'iframe[src*="hellowalla"], [data-walla-page="classes"]',
          { timeout: 20000 }
        );
      } catch {
        /* ignore */
      }

      // Give the network listener time to catch the JSON
      await page.waitForTimeout(3000);
      if (!classesJson) await page.waitForTimeout(4000);

      // ----- Fallback: call widget API directly from Node -----
      async function directFetchFromDom() {
        // Discover uuid and locationId from DOM or use env vars
        const meta = await page.evaluate(() => {
          const out = {};
          const nodes = Array.from(
            document.querySelectorAll('script[src],iframe[src]')
          );
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
          const root = document.querySelector(
            '[data-walla-id],[data-walla-locationid]'
          );
          if (root) {
            if (!out.uuid)
              out.uuid = root.getAttribute('data-walla-id') || out.uuid;
            if (!out.locationId)
              out.locationId =
                root.getAttribute('data-walla-locationid') || out.locationId;
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
          `uuid=${encodeURIComponent(uuid)}&locationId=${encodeURIComponent(
            locationId
          )}` +
          (s ? `&start=${encodeURIComponent(s)}` : '') +
          (e ? `&end=${encodeURIComponent(e)}` : '');

        // Node18+ has global fetch. If older Node, install `node-fetch`.
        const r = await fetch(apiUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: referer,
          },
        });
        if (!r.ok) return null;
        const data = await r.json();
        return Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
      }

      if (!classesJson) {
        try {
          classesJson = await directFetchFromDom();
        } catch {
          /* ignore */
        }
      }

      // Optional debug snapshot when still empty
      if ((!classesJson || !Array.isArray(classesJson)) && debug) {
        const title = (await page.title().catch(() => '')) || '';
        const html = (await page.content().catch(() => '')) || '';
        return { debug: { title, sample: html.slice(0, 2000) }, classes: [] };
      }

      return { classes: normalize(classesJson || []) };
    });

    if (result.debug) {
      return res.json({
        start: startISO,
        end: endISO,
        count: 0,
        classes: [],
        debug: result.debug,
      });
    }

    return res.json({
      start: startISO,
      end: endISO,
      count: result.classes.length,
      classes: result.classes,
    });
  } catch (e) {
    console.error('scrape-classes failed:', e);
    return res.status(500).json({ error: 'navigation_failed', details: String(e) });
  }
});

// Example for a future "direct only" route if you want it (disabled now):
// app.get('/scrape-classes-direct', async (req, res) => {
//   const { start, end, locationId = process.env.WALLA_LOCATION_ID || '3589', uuid = process.env.WALLA_UUID || '' } = req.query;
//   if (!uuid) return res.status(400).json({ error: 'missing uuid' });
//   const s = toISODateStr(start);
//   const e = toISODateStr(end);
//   const apiUrl = `https://widget.hellowalla.com/api/classes?uuid=${encodeURIComponent(uuid)}&locationId=${encodeURIComponent(locationId)}${s ? `&start=${encodeURIComponent(s)}` : ''}${e ? `&end=${encodeURIComponent(e)}` : ''}`;
//   const r = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
//   const data = await r.json();
//   const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
//   return res.json({ count: rows.length, classes: normalize(rows) });
// });

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error', details: String(err) });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('walla-scraper listening on ' + PORT));
