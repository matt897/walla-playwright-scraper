import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.send('ok'));

app.use((req, res, next) => {
  const AUTH_TOKEN = process.env.SCRAPER_TOKEN || '';
  if (!AUTH_TOKEN) return next();
  const token = req.get('x-api-key') || req.query.key;
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// No template literals so compose doesn't interpolate
const LOCAL_HTML = ({ start, end }) => (
  '<!doctype html><html><head><meta charset="utf-8"/></head><body>'
  + '<div class="walla-widget-root" '
  + 'data-walla-id="3f4c5689-8468-47d5-a722-c0ab605b2da4" '
  + 'data-walla-page="classes" '
  + 'data-walla-locationid="3589" '
  + 'data-start="' + (start || '') + '" '
  + 'data-end="' + (end || '') + '"></div>'
  + '<script>(function(w,a,l,la,j,s){'
  + 'const t=a.getElementById("walla-widget-script"); if(t) return;'
  + 'j=a.createElement(l); j.async=1; j.src=la; j.id="walla-widget-script";'
  + 's=a.getElementsByTagName(l)[0]||a.body; s.parentNode.insertBefore(j,s);'
  + '})(window,document,"script","https://widget.hellowalla.com/loader/v1/walla-widget-loader.js");</script>'
  + '</body></html>'
);

function coerceArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.classes)) return payload.classes;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.results)) return payload.results;
  }
  return null;
}

function normalize(list = []) {
  return list.map(c => {
    const cap = Number(c?.capacity ?? c?.maxCapacity ?? 0);
    const booked = Number(c?.booked ?? c?.bookedCount ?? c?.enrolled ?? 0);
    const open = Math.max(cap - booked, 0);
    return {
      class_id: c?.id ?? c?.classId ?? null,
      class_name: c?.name ?? c?.className ?? '',
      instructor: (c?.instructor && (c.instructor.name || c.instructor)) || '',
      start_time: c?.start ?? c?.startTime ?? null,
      end_time: c?.end ?? c?.endTime ?? null,
      room: c?.room ?? c?.roomName ?? '',
      location_id: c?.locationId ?? 3589,
      capacity: cap,
      booked,
      open_spots: open,
      waitlist_count: Number(c?.waitlist ?? c?.waitlistCount ?? 0),
      has_open_spots: open > 0
    };
  });
}

app.get('/scrape-classes', async (req, res) => {
  const { start, end, url, debug } = req.query;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();

  // Capture useful debug info
  const seenUrls = [];
  page.on('request', r => { try { seenUrls.push(r.url()); } catch {} });

  let classesJson = null;

  // Be flexible: catch any network response whose URL contains 'classes' or 'schedule'
  page.on('response', async (r) => {
    try {
      const u = new URL(r.url());
      const ct = (r.headers()['content-type'] || '').toLowerCase();
      if ((u.pathname.includes('classes') || u.pathname.includes('schedule')) && ct.includes('application/json')) {
        const data = await r.json();
        const arr = coerceArray(data);
        if (arr) classesJson = arr;
      }
    } catch { /* ignore */ }
  });

  try {
    if (url) {
      await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
    } else {
      await page.setContent(LOCAL_HTML({ start, end }), { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    // Wait for either the JSON fetch or a likely widget element
    const waiters = [
      page.waitForResponse(r => {
        try { return r.url().includes('classes') || r.url().includes('schedule'); } catch { return false; }
      }, { timeout: 30000 }).catch(() => null),
      page.waitForSelector('.walla-widget-root, [data-walla-id]', { timeout: 15000 }).catch(() => null)
    ];
    await Promise.race(waiters);

    // Give some extra time for the widget to finish loading
    if (!classesJson) await page.waitForTimeout(3000);
  } catch (e) {
    await browser.close();
    return res.status(500).json({ error: 'navigation_failed', details: String(e) });
  }

  const html = debug ? await page.content().catch(() => '') : '';
  await browser.close();

  const out = normalize(classesJson || []);
  if (debug) {
    return res.json({
      start, end,
      count: out.length,
      sampleUrls: seenUrls.slice(-20),   // last 20 URLs
      htmlPreview: html.slice(0, 2000),  // first 2KB so response stays small
      classes: out
    });
  }
  return res.json({ start, end, count: out.length, classes: out });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error', details: String(err) });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('walla-scraper listening on ' + PORT));
