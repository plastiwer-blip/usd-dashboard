// server.js — arranque inmediato + scraping en background (sin Excel)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const REFRESH_MS = Number(process.env.REFRESH_MS || 5 * 60 * 1000);
const PUP_CACHE = process.env.PUPPETEER_CACHE_DIR || '/opt/render/project/.cache/puppeteer';

// ---------- utils ----------
const parseNum = (txt) => {
  const n = Number(String(txt || '').replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

// ---------- scrapers ----------
async function scrapeFintechAverages(page) {
  await page.goto('https://cuantoestaeldolar.pe', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('div[class*="ExchangeHouseItem_item__"]', { timeout: 60000 });

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
  await page.goto('https://www.bloomberglinea.com/quote/USDPEN:CUR/', {
    waitUntil: 'networkidle2',
    timeout: 120000
  });

  // esperar a que aparezca el elemento en vez de usar waitForTimeout
  await page.waitForSelector('h2.px-last', { timeout: 15000 });

  const val = await page.evaluate(() => {
    const el = document.querySelector('h2.px-last');
    if (!el) return null;
    const n = parseFloat(el.textContent.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  });

  return Number.isFinite(val) ? Number(val.toFixed(4)) : NaN;
}

// ---------- servidor web ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// sirve assets estáticos desde /public
app.use(express.static(path.join(__dirname, 'public')));

// sirve index.html que está en la raíz del proyecto
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// health check
app.get('/api/health', (_, res) => res.json({ ok: true, started: true }));

let liveSeries = [];
io.on('connection', s => s.emit('boot', liveSeries));

server.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  startBackgroundLoop();
});

// ---------- Puppeteer ----------
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
  } catch {
    return null;
  }
}

function resolveExecutablePath() {
  let execPath = puppeteer.executablePath();
  if (execPath && fs.existsSync(execPath)) return execPath;
  const newest = findNewestChrome();
  if (newest) return newest;
  return null;
}

let browser;
async function launchBrowser() {
  if (browser) return browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      channel: 'chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('✅ Puppeteer lanzado (channel=chrome)');
    return browser;
  } catch (e) {
    console.warn('channel=chrome no disponible:', e.message);
  }

  const execPath = resolveExecutablePath();
  console.log('➡️ executablePath seleccionado:', execPath || '(no encontrado)');

  if (!execPath) {
    throw new Error(`No se encontró Chrome. Asegúrate de instalarlo en build con:
npx @puppeteer/browsers install chrome@stable --path=$PUPPETEER_CACHE_DIR`);
  }

  browser = await puppeteer.launch({
    headless: true,
    executablePath: execPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  console.log('✅ Puppeteer lanzado (executablePath)');
  return browser;
}

// ---------- ciclo en background ----------
async function runOnceSafe() {
  const ts = new Date();
  let bidAvg = NaN, askAvg = NaN, spot = NaN, fin = null, sampleCount = 0;

  try {
    const b = await launchBrowser();
    const page = await b.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
    );

    try {
      fin = await scrapeFintechAverages(page);
      bidAvg = fin.bidAvg; askAvg = fin.askAvg; sampleCount = fin.sampleCount;
    } catch (e) { console.error('Fintech error:', e.message); }

    try {
      spot = await scrapeBloombergSpot(page);
    } catch (e) { console.error('Bloomberg error:', e.message); }

    await page.close().catch(() => {});
  } catch (e) {
    console.error('Tick fatal:', e);
  }

  let bestBuy = null, bestSell = null;
  if (fin && fin.raw?.length) {
    bestBuy  = fin.raw.map(f => ({ name: f.name, buy: parseNum(f.sell) }))
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
  runOnceSafe();
  setInterval(runOnceSafe, REFRESH_MS);
}

// cierre limpio
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { if (browser) await browser.close(); } catch {}
    process.exit(0);
  });
}







