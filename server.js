import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Allow /healthz without auth so Portainer healthchecks don’t need a key
app.get('/healthz', (_req, res) => res.send('ok'));

// Simple auth for the rest
app.use((req, res, next) => {
  const AUTH_TOKEN = process.env.SCRAPER_TOKEN || '';
  if (!AUTH_TOKEN) return next();
  const token = req.get('x-api-key') || req.query.key;
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// Build the HTML w/out template literals (no ${} so compose doesn’t interpolate)
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

function normalize(list = []) {
  return list.map(c => {
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
      has_open_spots: open > 0
    };
  });
}

app.get('/scrape-classes', async (req, res) => {
  const { start, end, url } = req.query;
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();

  let classesJson = null;
  const targetPath = '/api/classes';

  page.on('response', async (r) => {
    try {
      const u = new URL(r.url());
      const ct = (r.headers()['content-type'] || '').toLowerCase();
      if (u.pathname.includes(targetPath) && ct.includes('application/json')) {
        const data = await r.json();
        if (Array.isArray(data)) classesJson = data;
      }
    } catch {}
  });

  try {
    if (url) {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await page.goto(String(url), { waitUntil: 'domcontentloaded' });
    } else {
      await page.setContent(LOCAL_HTML({ start, end }), { waitUntil: 'domcontentloaded' });
    }

    try {
      await page.waitForResponse((r) => r.url().includes(targetPath), { timeout: 30000 });
    } catch {}
    if (!classesJson) await page.waitForTimeout(2000);
  } catch (e) {
    await browser.close();
    return res.status(500).json({ error: 'navigation_failed', details: String(e) });
  }

  await browser.close();
  const out = normalize(classesJson || []);
  res.json({ start, end, count: out.length, classes: out });
});

// Helpful error handler so the process doesn’t die silently
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error', details: String(err) });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('walla-scraper listening on ' + PORT));
