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

// ---------- Local HTML shell for the widget ----------
const LOCAL_HTML = ({ start, end }) =>
  '<!doctype html><html><head><meta charset="utf-8"/></head><body>' +
  '<div class="walla-widget-root" ' +
  'data-walla-id="3f4c5689-8468-47d5-a722-c0ab605b2da4" ' + // set yours if different
  'data-walla-page="classes" ' +
  'data-walla-locationid="3589" ' +                         // set yours if different
  `data-start="${start || ''}" data-end="${end || ''}"></div>` +
  '<script>(function(w,a,l,la,j,s){' +
  'const t=a.getElementById("walla-widget-script"); if(t) return;' +
  'j=a.createElement(l); j.async=1; j.src=la; j.id="walla-widget-script";' +
  's=a.getElementsByTagName(l)[0]||a.body; s.parentNode.insertBefore(j,s);' +
  '})(window,document,"script","https://widget.hellowalla.com/loader/v1/walla-widget-loader.js");</script>' +
  '</body></html>';

// ---------- Playwright launcher ----------
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
    return await fn({ browser, context, page });
  } finally {
    await browser.close();
  }
}

const toISO = (v) => (v || '').toString().slice(0, 10);

async function getWidgetFrame(page) {
  // Wait for the iframe that hosts the Walla widget
  const iframeEl = await page.waitForSelector('iframe[src*="widget.hellowalla.com"]', { timeout: 45000 });
  const frame = await iframeEl.contentFrame();
  if (!frame) throw new Error('widget_frame_not_ready');
  return frame;
}

// ---------- Route: capture PNG of the widget ----------
// GET /capture-schedule?start=YYYY-MM-DD&end=YYYY-MM-DD[&url=...][&dpr=2][&delay=1500][&fullPage=0]
app.get('/capture-schedule', async (req, res) => {
  const startISO = toISO(req.query.start);
  const endISO   = toISO(req.query.end);
  const dpr      = Number(req.query.dpr || 2);
  const delayMs  = Number(req.query.delay || 1500);
  const fullPage = String(req.query.fullPage || '0') === '1';
  const referer  = String(req.query.url || '');

  try {
    const pngBuffer = await withBrowser(async ({ page }) => {
      // Block common trackers that keep connections open
      await page.route('**/*', route => {
        const u = route.request().url();
        if (/\b(googletagmanager|google-analytics|doubleclick|hotjar|facebook|segment|sentry|intercom|hs-scripts)\b/i.test(u)) {
          return route.abort();
        }
        route.continue();
      });

      if (referer) {
        await page.goto(referer, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      } else {
        await page.setContent(LOCAL_HTML({ start: startISO, end: endISO }), {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }

      // Wait for the widget iframe and give it a moment to render classes
      const frame = await getWidgetFrame(page);
      // Scroll through the frame to trigger any lazy loads
      await frame.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 6; i++) {
          window.scrollTo(0, document.body.scrollHeight);
          await sleep(250);
        }
        window.scrollTo(0, 0);
      });

      // Optionally wait a beat for badges/buttons to paint
      await page.waitForTimeout(delayMs);

      // Screenshot either the whole page or just the widget frame body
      if (fullPage) {
        return await page.screenshot({ type: 'png', fullPage: true });
      } else {
        return await frame.locator('body').screenshot({ type: 'png' });
      }
    }, { dpr });

    res.setHeader('Content-Type', 'image/png');
    return res.status(200).send(pngBuffer);
  } catch (e) {
    console.error('capture-schedule failed:', e);
    return res.status(500).json({ error: 'capture_failed', details: String(e) });
  }
});

// ---------- Route: capture TEXT from the widget (no OCR) ----------
// GET /capture-schedule-text?start=YYYY-MM-DD&end=YYYY-MM-DD[&url=...]
app.get('/capture-schedule-text', async (req, res) => {
  const startISO = toISO(req.query.start);
  const endISO   = toISO(req.query.end);
  const referer  = String(req.query.url || '');

  try {
    const out = await withBrowser(async ({ page }) => {
      // Lightweight nav (no networkidle)
      if (referer) {
        await page.goto(referer, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      } else {
        await page.setContent(LOCAL_HTML({ start: startISO, end: endISO }), {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }

      // Grab innerText from the iframe
      const frame = await getWidgetFrame(page);

      // Best-effort wait for any "SPOT(S)" or "Waitlist" text to appear
      await frame.waitForTimeout(1200);
      const text = await frame.evaluate(() => document.body.innerText || '');

      // Quick heuristic parse (optional)
      const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
      const timeRe = /\b([0-1]?\d:[0-5]\d)\s*([AP]M)\b/i;
      const rows = [];
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        const timeMatch = L.match(timeRe);
        const spotsMatch = L.match(/\b(\d+)\s*SPOTS?\b/i);
        const waitlist = /waitlist/i.test(L);
        const full = /sold\s*out|full/i.test(L);

        if (timeMatch || spotsMatch || waitlist || full) {
          // Look around this line for a plausible class name
          const context = [lines[i-2], lines[i-1], L, lines[i+1], lines[i+2]].filter(Boolean).join(' | ');
          rows.push({
            date: startISO,
            time: timeMatch ? `${timeMatch[1]} ${timeMatch[2].toUpperCase()}` : '',
            class_name: context.split('|')[0]?.trim() || '',
            open_spots: spotsMatch ? parseInt(spotsMatch[1], 10) : (waitlist || full ? 0 : null),
            status: waitlist ? 'waitlist' : (full ? 'full' : (spotsMatch ? (parseInt(spotsMatch[1],10)>0 ? 'open' : 'full') : 'unknown')),
            raw: L
          });
        }
      }

      return { text, parsed: rows };
    });

    return res.json({ start: startISO, end: endISO, ...out });
  } catch (e) {
    console.error('capture-schedule-text failed:', e);
    return res.status(500).json({ error: 'text_capture_failed', details: String(e) });
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
app.listen(PORT, () => console.log('walla-capture listening on ' + PORT));
