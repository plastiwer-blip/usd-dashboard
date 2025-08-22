// server.js – versión sin Excel (histórico solo en memoria "del día")
// Requiere: npm i express socket.io puppeteer

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Frecuencia de actualización (ms): 5 min por defecto (ajústalo si quieres)
const REFRESH_MS = Number(process.env.REFRESH_MS || 5 * 60 * 1000);

// ===== Utiles =====
function parseNum(txt) {
  if (!txt) return NaN;
  const norm = String(txt).replace(/\s+/g, '').replace(',', '.');
  const n = Number(norm);
  return Number.isFinite(n) ? n : NaN;
}

// ===== Scrapers (mismos sitios que ya usabas) =====
async function scrapeFintechAverages(page) {
  // Promedios y muestras desde cuantoestaeldolar.pe
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
    }).filter(x => x);
  });

  const buys = rows.map(r => parseNum(r.buy)).filter(n => Number.isFinite(n) && n > 0);
  const sells = rows.map(r => parseNum(r.sell)).filter(n => Number.isFinite(n) && n > 0);

  const bidAvg = buys.length ? buys.reduce((a,b)=>a+b,0)/buys.length : NaN;
  const askAvg = sells.length ? sells.reduce((a,b)=>a+b,0)/sells.length : NaN;

  return { bidAvg, askAvg, sampleCount: rows.length, raw: rows };
}

async function scrapeBloombergSpot(page) {
  // Spot de referencia (Bloomberg Línea USDPEN)
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

// ===== Servidor + Dashboard =====
(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled']
  });

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  // Sirve /public (tu index.html y demás) – igual que antes
  app.use(express.static(path.join(__dirname, 'public')));

  // Serie en memoria (del día). Sin Excel ni archivos.
  let liveSeries = [];

  // Al conectar un cliente: enviamos lo que haya en memoria (puede estar vacío)
  io.on('connection', socket => {
    socket.emit('boot', liveSeries);
  });

  // Job de toma de datos (igual a antes pero sin escribir Excel)
  async function runOnce() {
    const ts = new Date();
    console.log('⏳ Toma de datos @', ts.toLocaleString('es-PE', { hour12: false, timeZone: 'America/Lima' }));

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    let bidAvg = NaN, askAvg = NaN, spot = NaN, sampleCount = 0, fin = null;

    // Fintech (cuantoestaeldolar.pe)
    try {
      fin = await scrapeFintechAverages(page);
      bidAvg = fin.bidAvg;
      askAvg = fin.askAvg;
      sampleCount = fin.sampleCount; // número de fintechs leídas
      console.log(`✅ Fintech: ${sampleCount} fuentes | BidAvg=${bidAvg?.toFixed?.(4)} | AskAvg=${askAvg?.toFixed?.(4)}`);
    } catch(e) {
      console.error('❌ Error fintech:', e.message);
    }

    // Spot Bloomberg
    try {
      spot = await scrapeBloombergSpot(page);
      console.log(`✅ Bloomberg Spot: ${Number.isFinite(spot)?spot:'NaN'}`);
    } catch(e) {
      console.error('❌ Error Bloomberg:', e.message);
    }

    await page.close().catch(()=>{});

    // Mejor compra y venta según la lista cruda (igual que tu lógica original)
    // bestBuy: menor precio de "sell" (donde te venden USD más barato)
    // bestSell: mayor precio de "buy" (donde te compran USD más caro)
    let bestBuy = null, bestSell = null;
    if (fin && Array.isArray(fin.raw) && fin.raw.length) {
      bestBuy = fin.raw.map(f=>({name:f.name, buy: parseNum(f.sell)}))
                       .filter(f=>Number.isFinite(f.buy)&&f.buy>0)
                       .sort((a,b)=>a.buy-b.buy)[0] || null;

      bestSell = fin.raw.map(f=>({name:f.name, sell: parseNum(f.buy)}))
                        .filter(f=>Number.isFinite(f.sell)&&f.sell>0)
                        .sort((a,b)=>b.sell-a.sell)[0] || null;
    }

    // Punto a emitir/almacenar
    const point = {
      timestamp: ts.toISOString(),
      bid_avg: Number.isFinite(bidAvg) ? Number(bidAvg.toFixed(4)) : null,
      ask_avg: Number.isFinite(askAvg) ? Number(askAvg.toFixed(4)) : null,
      spot: Number.isFinite(spot) ? Number(spot.toFixed(4)) : null,
      bestBuy,  // { name, buy }
      bestSell, // { name, sell }
      sampleCount
    };

    // Guardar solo puntos del día (limpiamos si cambia la fecha)
    const today = new Date().toISOString().split('T')[0];
    liveSeries = liveSeries.filter(p => (p.timestamp||p.ts).split('T')[0] === today);
    liveSeries.push(point);
    if (liveSeries.length > 2000) liveSeries.shift();

    // Mandar a todos los clientes
    io.emit('tick', point);
  }

  // Primera ejecución y luego cada REFRESH_MS
  await runOnce();
  setInterval(runOnce, REFRESH_MS);

  server.listen(PORT, () => {
    console.log(`Servidor en http://localhost:${PORT}`);
  });
})();
