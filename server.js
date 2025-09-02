// ---------- Route: capture TEXT + structured rows from the widget (no PNG needed) ----------
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

      // Wait for widget iframe
      const iframeEl = await page.waitForSelector('iframe[src*="widget.hellowalla.com"]', { timeout: 45000 });
      const frame = await iframeEl.contentFrame();
      if (!frame) throw new Error('widget_frame_not_ready');

      // ---- NEW: Navigate to the requested date (use start= as target) ----
      const targetDate = startISO;  // click this day in the widget tabs
      await frame.waitForTimeout(1000);

      await frame.evaluate((iso) => {
        // Build a few label variants the widget uses in its tabs/headers
        const d = new Date(iso + 'T12:00:00');
        const dowShort = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
        const dowLong  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()];
        const monShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
        const monLong  = ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()];
        const day      = d.getUTCDate();

        const candidates = new Set([
          `${dowShort} ${monShort} ${day}`,             // "Wed Sep 3"
          `${monShort} ${day}`,                        // "Sep 3"
          `${dowLong.toUpperCase()}, ${monLong.toUpperCase()} ${day}`, // "WEDNESDAY, SEPTEMBER 3"
          `${dowLong}, ${monLong} ${day}`,             // "Wednesday, September 3"
        ]);

        // Click any element whose text matches one of the labels
        const clickables = Array.from(document.querySelectorAll('button,[role=tab],a,[role=button],.tab,.day')).filter(Boolean);
        const norm = s => (s||'').replace(/\s+/g,' ').trim();
        let clicked = false;

        for (const el of clickables) {
          const t = norm(el.innerText || el.textContent || '');
          for (const want of candidates) {
            if (t.includes(want)) {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              clicked = true;
              break;
            }
          }
          if (clicked) break;
        }

        // If tabs didn’t match, try clicking the “next-day” control a few times
        if (!clicked) {
          const nextSelectors = [
            '[data-testid*="next"]',
            'button:has(svg[aria-label*="Next"])',
            'button:has(path[d])', // weak fallback
          ];
          const header = document.body.innerText || '';
          function headerHasWanted() {
            const H = header.toUpperCase();
            return H.includes(`${monLong.toUpperCase()} ${day}`) || H.includes(`${monShort.toUpperCase()} ${day}`);
          }
          let tries = 7;
          while (!headerHasWanted() && tries-- > 0) {
            for (const s of nextSelectors) {
              const btn = document.querySelector(s);
              if (btn) { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); break; }
            }
          }
        }
      }, targetDate);

      // Let the UI update
      await frame.waitForTimeout(800);

      // 1) Raw text snapshot (debug)
      const text = await frame.evaluate(() => document.body.innerText || '');

      // 2) Structured parse directly from DOM
      const rows = await frame.evaluate((defaultDate) => {
        const out = [];
        const qAll = (sel, root = document) => Array.from(root.querySelectorAll(sel));
        const txt  = (el) => (el?.innerText || '').trim();

        const candidates = qAll('[data-testid="class-row"], .class-row, .schedule-row, .class-item, li, tr, .row')
          .filter(el => (el && txt(el).length > 0));

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

        for (const row of candidates) {
          const rowText = txt(row);
          const tm = rowText.match(TIME_RE);
          const time = tm ? `${tm[1]} ${tm[2].toUpperCase()}` : '';
          if (!time) continue;

          let class_name = '';
          const nameEl = row.querySelector('a, .class-title, [data-testid="class-name"], h3, h4, [role="heading"]');
          if (nameEl) class_name = txt(nameEl);
          if (!class_name) {
            const parts = rowText.split('\n').map(s => s.trim()).filter(Boolean);
            for (const p of parts) { if (isCandidateName(p)) { class_name = p; break; } }
          }

          let instructor = '';
          const im = rowText.match(/w\/\s*([A-Za-z][A-Za-z .'-]+)/i);
          if (im) instructor = im[1].trim();

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
            status = 'open';
            open_spots = null; // count not visible
          }

          if (time && (class_name || status !== 'unknown')) {
            out.push({
              date: defaultDate || '',
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
      }, startISO);

      return { text, parsed: rows };
    });

    return res.json({ start: startISO, end: endISO, ...out });
  } catch (e) {
    console.error('capture-schedule-text failed:', e);
    return res.status(500).json({ error: 'text_capture_failed', details: String(e) });
  }
});
