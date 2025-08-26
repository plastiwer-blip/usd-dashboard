// server.js — web + scraping en background (Render-ready, sin Excel)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const REFRESH_MS = Number(process.env.REFRESH_MS || 5 * 60 * 1000);
const PUP_CACHE = process.env.PUPPETEER_CACHE_DIR || '/opt/render/project/.cache/puppeteer';

/* ------------------------------ utils ----------------------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const parseNum = (txt) => {
  const n = Number(String(txt || '').replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
async function withRetries(fn, retries = 2, delayMs = 2000) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < retries) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

/* ------------------------------ scrapers -------------------------------- */
async function scrapeFintechAverages(page) {
  await withRetries(
    () => page.goto('https://cuantoestaeldolar.pe', { waitUntil: 'domcontentloaded', timeout: 90000 }),
    2
  );
  await withRetries(
    () => page.waitForSelector('div[class*="ExchangeHouseItem_item__"]', { timeout: 90000 }),
    2
  );

  const rows = await page.evaluate(() => {
    const items = document.querySelectorAll('div[class*="ExchangeHouseItem_item__"]');
    return Array.from(items).map(it => {
      const name = it.querySelector('img')?.alt?.trim() || 'N/A';
      const prices = Array.from(it.querySelectorAll('p[class*="ValueCurrency_item_cost__"]'))
        .map(el => el.textContent?.trim() || '');
      if (prices.length >= 2) return { name, buy: prices[0], sell: prices[1] };
      return null;
    }).filter(Boolean);
  });

  const buys  = rows.map(r => parseNum(r.buy)).filter(n => Number.isFinite(n) && n > 0);
  const sells = rows.map(r => parseNum(r.sell)).filter(n => Number.isFinite(n) && n > 0);

  const bidAvg = buys.length  ? buys.reduce((a,b)=>a+b,0)/buys.length   : NaN;
  const askAvg = sells.length ? sells.reduce((a,b)=>a+b,0)/sells.length : NaN;

  return { bidAvg, askAvg, sampleCount: rows.length, raw: rows };
}

async function scrapeBloombergSpot(page) {
  await withRetries(
    () => page.goto('https://www.bloomberglinea.com/quote/USDPEN:CUR/', { waitUntil: 'domcontentloaded', timeout: 120000 }),
    2
  );
  await withRetries(
    () => page.waitForSelector('h2.px-last', { timeout: 20000 }),
    1
  );

  const val = await page.evaluate(() => {
    const el = document.querySelector('h2.px-last');
    if (!el) return null;
    const n = parseFloat(el.textContent.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  });

  return Number.isFinite(val) ? Number(val.toFixed(4)) : NaN;
}

/* ------------------------------ web server ------------------------------ */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// estáticos desde /public (css/js/img del front)
app.use(express.static(path.join(__dirname, 'public')));

// index.html en la raíz del proyecto
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// health check
app.get('/api/health', (_req, res) => res.json({ ok: true, started: true }));

// debug opcional
app.get('/debug-cache', (_req, res) => {
  res.json({
    cacheDir: PUP_CACHE,
    exists: fs.existsSync(PUP_CACHE),
    children: fs.existsSync(PUP_CACHE) ? fs.readdirSync(PUP_CACHE) : []
  });
});

let liveSeries = [];
io.on('connection', s => s.emit('boot', liveSeries));

server.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  startBackgroundLoop();
});

/* ------------------------------ puppeteer ------------------------------- */
function findNewestChrome(root = PUP_CACHE) {
  try {
    const chromeRoot = path.join(root, 'chrome');
    if (!fs.existsSync(chromeRoot)) return null;

    const candidates = fs.readdirSync(chromeRoot)
      .filter(name => name.startsWith('linux-'))
      .map(name => {
        const ver = name.replace('linux-', '');
        const exec = path.join(chromeRoot, name, 'chrome-linux64', 'chrome');
        return { ver, exec };
      })
      .filter(c => fs.existsSync(c.exec));

    if (!candidates.length) return null;
    candidates.sort((a, b) => a.ver.localeCompare(b.ver, undefined, { numeric: true })).reverse();
    return candidates[0].exec;
  } catch { return null; }
}

function resolveExecutablePath() {
  let p = puppeteer.executablePath();
  if (p && fs.existsSync(p)) return p;
  const newest = findNewestChrome();
  if (newest) return newest;
  return null;
}

let browser;
async function launchBrowser() {
  if (browser) return browser;

  // 1) intentar canal 'chrome'
  try {
    browser = await puppeteer.launch({
      headless: true,
      channel: 'chrome',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
    });
    console.log('✅ Puppeteer lanzado (channel=chrome)');
    return browser;
  } catch (e) {
    console.warn('channel=chrome no disponible:', e.message);
  }

  // 2) fallback al ejecutable detectado
  const execPath = resolveExecutablePath();
  console.log('➡️ executablePath seleccionado:', execPath || '(no encontrado)');
  if (!execPath) {
    throw new Error('Chrome no encontrado. Instálalo en build con @puppeteer/browsers y PUPPETEER_CACHE_DIR.');
  }

  browser = await puppeteer.launch({
    headless: true,
    executablePath: execPath,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
  });
  console.log('✅ Puppeteer lanzado (executablePath)');
  return browser;
}

/* ------------------------- background tick loop ------------------------- */
async function runOnceSafe() {
  const ts = new Date();
  let bidAvg = NaN, askAvg = NaN, spot = NaN, fin = null, sampleCount = 0;

  try {
    const b = await launchBrowser();
    const page = await b.newPage();

    // timeouts altos
    page.setDefaultTimeout(120000);
    page.setDefaultNavigationTimeout(120000);

    // UA y headers
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'accept-language': 'es-PE,es;q=0.9,en;q=0.8' });

    // ✅ Interceptar requests (Puppeteer)
    await page.setRequestInterception(true);
    page.removeAllListeners('request');
    page.on('request', (req) => {
      const type = req.resourceType();
      const url  = req.url();
      if (['image','media','font'].includes(type)) return req.abort();
      if (/\b(googletagmanager|google-analytics|doubleclick|facebook\.net)\b/i.test(url)) return req.abort();
      return req.continue();
    });

    try {
      fin = await scrapeFintechAverages(page);
      bidAvg = fin.bidAvg; askAvg = fin.askAvg; sampleCount = fin.sampleCount;
    } catch (e) {
      console.error('Fintech error:', e.name || e.code || e.message);
    }

    try {
      spot = await scrapeBloombergSpot(page);
    } catch (e) {
      console.error('Bloomberg error:', e.name || e.code || e.message);
    }

    await page.close().catch(() => {});
  } catch (e) {
    console.error('Tick fatal:', e);
  }

  // mejor compra/venta
  let bestBuy = null, bestSell = null;
  if (fin && fin.raw?.length) {
    bestBuy  = fin.raw.map(f => ({ name: f.name, buy:  parseNum(f.sell) }))
                      .filter(f => Number.isFinite(f.buy) && f.buy > 0)
                      .sort((a,b)=>a.buy-b.buy)[0] || null;

    bestSell = fin.raw.map(f => ({ name: f.name, sell: parseNum(f.buy) }))
                      .filter(f => Number.isFinite(f.sell) && f.sell > 0)
                      .sort((a,b)=>b.sell-a.sell)[0] || null;
  }

  const point = {
    timestamp: ts.toISOString(),
    bid_avg: Number.isFinite(bidAvg) ? Number(bidAvg.toFixed(4)) : null,
    ask_avg: Number.isFinite(askAvg) ? Number(askAvg.toFixed(4)) : null,
    spot:    Number.isFinite(spot)   ? Number(spot.toFixed(4))   : null,
    bestBuy, bestSell, sampleCount
  };

  const today = new Date().toISOString().split('T')[0];
  liveSeries = liveSeries.filter(p => (p.timestamp || p.ts).split('T')[0] === today);
  liveSeries.push(point);
  if (liveSeries.length > 2000) liveSeries.shift();

  io.emit('tick', point);
}

function startBackgroundLoop() {
  runOnceSafe();                    // primer tick inmediato
  setInterval(runOnceSafe, REFRESH_MS);
}

// cierre limpio
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { if (browser) await browser.close(); } catch {}
    process.exit(0);
  });
}






