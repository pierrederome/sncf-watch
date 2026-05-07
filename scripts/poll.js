// Polls the sncf-connect results page already loaded in a Chrome reachable at
// http://127.0.0.1:9222 (or PORT). Match = at least one journey with corr <= MAX_CORR
// AND a € price <= MAX_PRICE.
// Exit codes: 0 = match, 2 = no match yet, 1 = error, 3 = lost search state.
//
// Env vars:
//   MAX_CORR    integer, default 1
//   MAX_PRICE   float, default 9999 (effectively unlimited)
//   RUN_DIR     directory for artifacts, default $HOME/.sncf-watch/runs/_default
//   PORT        Chrome debug port, default 9222

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_CORR = parseInt(process.env.MAX_CORR || '1', 10);
const MAX_PRICE = parseFloat(process.env.MAX_PRICE || '9999');
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
        const complet = /complet/i.test(blockStr);
        const prices = [];
        const pRe = /(\d+(?:[ .]\d{3})*)(?:[,.](\d{1,2}))?\s*€/g;
        let pm;
        while ((pm = pRe.exec(blockStr)) !== null) prices.push(pm[0]);
        const uniq = Array.from(new Set(prices));
        journeys.push({
          dep_station: anchors[k].m[1],
          dep_time: anchors[k].m[2],
          arr_station: anchors[k].m[3],
          arr_time: anchors[k].m[4],
          duration: (blockStr.match(/(\d+h\d{2})/) || [])[1] || null,
          correspondances: corr,
          complet,
          prices: uniq,
        });
      }
      return { url: location.href, journeys };
    });

    for (const j of data.journeys) {
      j.min_price = j.prices.reduce((acc, p) => {
        const v = priceToFloat(p);
        return (v != null && (acc == null || v < acc)) ? v : acc;
      }, null);
    }

    fs.writeFileSync(path.join(RUN_DIR, 'last_results.json'), JSON.stringify(data, null, 2));

    const matches = data.journeys.filter(j =>
      j.correspondances != null && j.correspondances <= MAX_CORR &&
      j.min_price != null && j.min_price <= MAX_PRICE
    );

    const summary = {
      stamp: new Date().toISOString(),
      total: data.journeys.length,
      under_max_corr: data.journeys.filter(j => j.correspondances != null && j.correspondances <= MAX_CORR).length,
      bookable_any: data.journeys.filter(j => j.min_price != null).length,
      matches: matches.length,
      max_corr: MAX_CORR,
      max_price: MAX_PRICE,
    };
    console.log(JSON.stringify(summary));

    if (matches.length > 0) {
      const lines = [];
      lines.push(`MATCH at ${summary.stamp}`);
      lines.push(`Criteria: corr<=${MAX_CORR}, price<=${MAX_PRICE}€`);
      lines.push('');
      for (const j of matches) {
        lines.push(`- ${j.dep_time}→${j.arr_time} (${j.duration || '?'}) ${j.dep_station} → ${j.arr_station}`);
        lines.push(`    corr=${j.correspondances}  min=${j.min_price}€  prices=[${j.prices.join(', ')}]  complet=${j.complet}`);
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
