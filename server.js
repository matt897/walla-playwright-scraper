import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health check (no auth)
app.get('/healthz', (_req, res) => res.send('ok'));

// Auth (optional via SCRAPER_TOKEN env)
app.use((req, res, next) => {
  const AUTH_TOKEN = process.env.SCRAPER_TOKEN || '';
  if (!AUTH_TOKEN) return next();
  const token = req.get('x-api-key') || req.query.key;
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// Build the widget HTML (avoid ${} so compose won't interpolate)
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

// Normalize to a stable JSON shape
function normalize(list = []) {
  return list.map(c => {
    const cap = Number(c.capacity ?? c.maxCapacity ?? 0);
    const booked = Number(c.booked ?? c.bookedCount ?? c.enrolled ?? 0);
    const open = Math.max(cap - booked, 0);
    return {
      class_id: c.id ?? c.classId ?? null,
      class_name: c.name ?? c.className ?? '',
      instructor: (c && c.instructor && (c.instructor.name ?? c.instructor)) ?? '',
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

app.get('/scrape-classes', async (req, res) => {
  const { start, end, url, force } = req.query;

  let browser;
  let context;
  let page;

  // Collect JSON from the widget’s XHR/fetch
  let classesJson = null;
  const targetPath = '/api/classes';
  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    context = await browser.newContext({ userAgent, locale: 'en-US' });
    page = await context.newPage();

    // Extra safety: if the page crashes, fail quickly with a clear error
    let crashed = false;
    page.on('crash', () => (crashed = true));
    page.on('close', () => (crashed = true));

    page.on('response', async (r) => {
      try {
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('application/json')) return;
        const u = new URL(r.url());
        if (u.pathname.includes(targetPath)) {
          const data = await r.json();
          if (Array.isArray(data)) classesJson = data;
        }
      } catch {
        // swallow parse errors
      }
    });

    const useLocal = String(force || '').toLowerCase() === 'local' || !url;

    if (useLocal) {
      await page.setContent(LOCAL_HTML({ start, end }), { waitUntil: 'load', timeout: 45000 });
    } else {
      await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 45000 });
    }

    // Wait up to 45s for the API hit; then give the widget a little time
    try {
      await page.waitForResponse(
        (r) => {
          try {
            return new URL(r.url()).pathname.includes(targetPath);
          } catch {
            return false;
          }
        },
        { timeout: 45000 }
      );
    } catch {
      // it's okay if we timed out waiting; we'll still check classesJson
    }

    if (!classesJson && !crashed) {
      // small grace period for late responses
      await page.waitForTimeout(2000);
    }

    if (crashed) {
      throw new Error('page_crashed');
    }

    const out = normalize(classesJson || []);
    return res.json({ start, end, count: out.length, classes: out });
  } catch (e) {
    return res.status(500).json({
      error: 'navigation_failed',
      details: String(e && e.message ? e.message : e),
    });
  } finally {
    try {
      if (page) await page.close({ runBeforeUnload: false });
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
    try {
      if (browser) await browser.close();
    } catch {}
  }
});

// Global error guard
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error', details: String(err) });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('walla-scraper listening on ' + PORT));
