// Polls the sncf-connect results page already loaded in a Chrome reachable at
// http://127.0.0.1:9222 (or PORT).
//
// Match predicate, applied per journey:
//   correspondances <= MAX_CORR
//   AND (DEP_TIME unset OR dep_time === DEP_TIME)
//   AND at least one *class option* in the journey block satisfies:
//        price <= MAX_PRICE
//        AND (seats_left === null OR seats_left >= MIN_SEATS)
//
// "Class options" are extracted by pairing each visible € price with the
// nearest preceding "(\d+) place(s) à ce prix" warning within the same block;
// no warning means unrestricted availability for that class.
//
// Exit codes: 0 = match, 2 = no match yet, 1 = error, 3 = lost search state.
//
// Env vars:
//   MAX_CORR    integer, default 1
//   MAX_PRICE   float, default 9999 (effectively unlimited)
//   MIN_SEATS   integer, default 1 (number of seats needed)
//   DEP_TIME    optional "HH:MM" — only match journeys with this exact departure time
//   RUN_DIR     directory for artifacts, default $HOME/.sncf-watch/runs/_default
//   PORT        Chrome debug port, default 9222

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_CORR = parseInt(process.env.MAX_CORR || '1', 10);
const MAX_PRICE = parseFloat(process.env.MAX_PRICE || '9999');
const MIN_SEATS = parseInt(process.env.MIN_SEATS || '1', 10);
const DEP_TIME = (process.env.DEP_TIME || '').trim();
const PORT = parseInt(process.env.PORT || '9222', 10);
const RUN_DIR = process.env.RUN_DIR || path.join(os.homedir(), '.sncf-watch', 'runs', '_default');
const RESULTS_URL = 'https://www.sncf-connect.com/home/shop/results/outward';
fs.mkdirSync(RUN_DIR, { recursive: true });
fs.mkdirSync(path.join(RUN_DIR, 'shots'), { recursive: true });

function priceToFloat(s) {
  // Accepts "137,10 €", "45 €", "1 234,50 €", "1.234,50 €"
  const m = s.match(/(\d+(?:[ .]\d{3})*)(?:[,.](\d{1,2}))?\s*€/);
  if (!m) return null;
  const whole = m[1].replace(/[ .]/g, '');
  const frac = m[2] || '0';
  return parseFloat(`${whole}.${frac}`);
}

(async () => {
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  } catch (e) {
    console.error('[connect-fail]', e.message);
    process.exit(1);
  }
  try {
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('sncf-connect.com')) || pages[0];

    if (!page.url().includes('/results/')) {
      console.error(`[nav] not on results, going to ${RESULTS_URL}`);
      await page.goto(RESULTS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    } else {
      await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    }
    await new Promise(r => setTimeout(r, 2500));

    const url = page.url();
    if (!url.includes('/results/')) {
      console.error(`[stale] after reload landed on ${url} — search state lost`);
      try { await page.screenshot({ path: path.join(RUN_DIR, 'shots', 'poll-stale.png') }); } catch {}
      process.exit(3);
    }

    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const journeys = [];
      const anchorRe = /^Départ de (.+?) (\d{1,2}:\d{2}) à destination de (.+?) (\d{1,2}:\d{2})$/;
      const priceLineRe = /^(\d+(?:[ .]\d{3})*)(?:[,.](\d{1,2}))?\s*€$/;
      const seatsLineRe = /^(\d+)\s*place/i;
      const anchors = [];
      lines.forEach((l, i) => { const m = l.match(anchorRe); if (m) anchors.push({ i, m }); });
      for (let k = 0; k < anchors.length; k++) {
        const start = anchors[k].i;
        const end = k + 1 < anchors.length ? anchors[k+1].i : lines.length;
        const block = lines.slice(start, end);
        const blockStr = block.join(' | ');
        const corrM = blockStr.match(/(\d+)\s*correspondance/i);
        const direct = /\b(direct|trajet direct)\b/i.test(blockStr);
        const corr = direct ? 0 : (corrM ? parseInt(corrM[1], 10) : null);
        const complet = /complet|non\s+r[ée]servable/i.test(blockStr);

        // Build class options: each €-price line, paired with the nearest preceding
        // seats warning ("(\d+) place(s)") within 4 lines (null = no constraint).
        const options = [];
        for (let li = 0; li < block.length; li++) {
          const pm = block[li].match(priceLineRe);
          if (!pm) continue;
          let seats_left = null;
          for (let lookback = 1; lookback <= 4 && li - lookback >= 0; lookback++) {
            const sm = block[li - lookback].match(seatsLineRe);
            if (sm) { seats_left = parseInt(sm[1], 10); break; }
          }
          options.push({ raw: block[li], seats_left });
        }
        // Numeric value per option
        for (const o of options) {
          const m = o.raw.match(/(\d+(?:[ .]\d{3})*)(?:[,.](\d{1,2}))?\s*€/);
          if (m) {
            const whole = m[1].replace(/[ .]/g, '');
            const frac = m[2] || '0';
            o.price = parseFloat(`${whole}.${frac}`);
          }
        }

        journeys.push({
          dep_station: anchors[k].m[1],
          dep_time: anchors[k].m[2],
          arr_station: anchors[k].m[3],
          arr_time: anchors[k].m[4],
          duration: (blockStr.match(/(\d+h\d{2})/) || [])[1] || null,
          correspondances: corr,
          complet,
          options, // [{raw, price, seats_left}]
        });
      }
      return { url: location.href, journeys };
    });

    // Per-journey: filter eligible options, pick min price, derive min_price for display.
    for (const j of data.journeys) {
      j.eligible_options = j.options.filter(o =>
        typeof o.price === 'number' &&
        o.price <= MAX_PRICE &&
        (o.seats_left == null || o.seats_left >= MIN_SEATS)
      );
      j.min_price = j.options.reduce((acc, o) =>
        (typeof o.price === 'number' && (acc == null || o.price < acc)) ? o.price : acc, null);
    }

    fs.writeFileSync(path.join(RUN_DIR, 'last_results.json'), JSON.stringify(data, null, 2));

    const matches = data.journeys.filter(j =>
      j.correspondances != null && j.correspondances <= MAX_CORR &&
      (!DEP_TIME || j.dep_time === DEP_TIME) &&
      j.eligible_options.length > 0
    );

    const summary = {
      stamp: new Date().toISOString(),
      total: data.journeys.length,
      under_max_corr: data.journeys.filter(j => j.correspondances != null && j.correspondances <= MAX_CORR).length,
      bookable_any: data.journeys.filter(j => j.options.some(o => typeof o.price === 'number')).length,
      matches: matches.length,
      filters: { max_corr: MAX_CORR, max_price: MAX_PRICE, min_seats: MIN_SEATS, dep_time: DEP_TIME || null },
    };
    console.log(JSON.stringify(summary));

    if (matches.length > 0) {
      const lines = [];
      lines.push(`MATCH at ${summary.stamp}`);
      const filterParts = [`corr<=${MAX_CORR}`, `price<=${MAX_PRICE}€`, `seats>=${MIN_SEATS}`];
      if (DEP_TIME) filterParts.push(`dep=${DEP_TIME}`);
      lines.push(`Criteria: ${filterParts.join(', ')}`);
      lines.push('');
      for (const j of matches) {
        lines.push(`- ${j.dep_time}→${j.arr_time} (${j.duration || '?'}) ${j.dep_station} → ${j.arr_station}`);
        const opts = j.eligible_options.map(o => `${o.raw}${o.seats_left != null ? ` [${o.seats_left} place${o.seats_left>1?'s':''}]` : ''}`).join(', ');
        lines.push(`    corr=${j.correspondances}  options=[${opts}]  complet=${j.complet}`);
      }
      const txt = lines.join('\n') + '\n';
      fs.writeFileSync(path.join(RUN_DIR, 'MATCH.txt'), txt);
      fs.writeFileSync(path.join(RUN_DIR, 'MATCH.json'), JSON.stringify({ summary, matches }, null, 2));
      process.stdout.write(txt);
      process.exit(0);
    } else {
      process.exit(2);
    }
  } catch (e) {
    console.error('[error]', e.stack || e.message);
    process.exit(1);
  } finally {
    try { await browser.disconnect(); } catch {}
  }
})();
