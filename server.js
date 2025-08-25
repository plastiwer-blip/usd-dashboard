// server.js — arranque inmediato + scraping en background (sin Excel)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const REFRESH_MS = Number(process.env.REFRESH_MS || 5 * 60 * 1000);

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
  await page.goto('https://www.bloomberglinea.com/quote/USDPEN:CUR/', { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForTimeout(3000);
  const val = await page.evaluate(() => {
    const el = document.querySelector('h2.px-last');
    if (!el) return null;
    const n = parseFloat(el.textContent.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  });
  return Number.isFinite(val) ? Number(val.toFixed(4)) : NaN;
}

// ---------- servidor web (arranca YA para evitar 502) ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_, res) => res.json({ ok: true, started: true }));

let liveSeries = [];
io.on('connection', s => s.emit('boot', liveSeries));

server.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  startBackgroundLoop(); // no bloquea el arranque
});

// ---------- Puppeteer: localizar binario de navegador ----------
function findChromeInCache(root = '/opt/render/.cache/puppeteer') {
  try {
    if (!fs.existsSync(root)) return null;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile() && e.name === 'chrome') return p; // ejecutable
      }
    }
  } catch (_) {}
  return null;
}

let browser;
async function launchBrowser() {
  if (browser) return browser;

  // 1) Primero intenta usar el Chrome instalado (canal "chrome")
  try {
    browser = await puppeteer.launch({
      headless: true,
      channel: 'chrome', // usa el Chrome instalado por @puppeteer/browsers
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('✅ Puppeteer lanzado (channel=chrome)');
    return browser;
  } catch (e) {
    console.warn('No se pudo lanzar con channel=chrome, probando executablePath…', e.message);
  }

  // 2) Luego intenta con la ruta que resuelve Puppeteer
  let execPath = puppeteer.executablePath();
  if (!execPath || !fs.existsSync(execPath)) {
    // 3) Fallback: busca el binario en la caché de Render
    const root = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    const found = (function findChromeInCache(rootDir) {
      try {
        if (!fs.existsSync(rootDir)) return null;
        const stack = [rootDir];
        while (stack.length) {
          const dir = stack.pop();
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.isFile() && (e.name === 'chrome' || e.name === 'chromium')) return p;
          }
        }
      } catch (_) {}
      return null;
    })(root);
    if (found) execPath = found;
  }

  console.log('➡️ executablePath seleccionado:', execPath || '(vacío)');
  if (!execPath || !fs.existsSync(execPath)) {
    throw new Error(
      'No se encontró Chrome. Asegúrate de instalarlo en build con: ' +
      'npx @puppeteer/browsers install chrome@stable --path=$PUPPETEER_CACHE_DIR'
    );
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
    bestBuy  = fin.raw.map(f => ({ name: f.name, buy:  parseNum(f.sell) }))
                      .filter(f => Number.isFinite(f.buy)  && f.buy  > 0)
                      .sort((a,b)=>a.buy-b.buy)[0] || null;

    bestSell = fin.raw.map(f => ({ name: f.name, sell: parseNum(f.buy)  }))
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
  runOnceSafe();                    // primer tick
  setInterval(runOnceSafe, REFRESH_MS); // siguientes
}

