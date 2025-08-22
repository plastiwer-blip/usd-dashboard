// server.js – sin Excel, listo para Render
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');

const PORT = process.env.PORT || 3000;
const REFRESH_MS = Number(process.env.REFRESH_MS || 5 * 60 * 1000);

// ---------- util ----------
function parseNum(txt){ if(!txt) return NaN; const n=Number(String(txt).replace(/\s+/g,'').replace(',', '.')); return Number.isFinite(n)?n:NaN; }

// ---------- scrapers ----------
async function scrapeFintechAverages(page){
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

async function scrapeBloombergSpot(page){
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

// ---------- app ----------
(async () => {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.use(express.static(path.join(__dirname, 'public')));

  let liveSeries = [];

  io.on('connection', (socket) => { socket.emit('boot', liveSeries); });

  // Lanzamiento robusto de Puppeteer en Render
  let browser = null;
  async function launchBrowser() {
    if (browser) return browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        channel: 'chrome', // usa el Chrome instalado en postinstall
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
      });
      console.log('✅ Puppeteer lanzado con channel=chrome');
    } catch (e1) {
      console.error('⚠️ Falló channel=chrome, intento con Chromium bundle:', e1.message);
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
      });
      console.log('✅ Puppeteer lanzado con Chromium bundle');
    }
    return browser;
  }

  async function runOnce(){
    const ts = new Date();
    console.log('⏳ Tick @', ts.toISOString());
    let bidAvg=NaN, askAvg=NaN, spot=NaN, sampleCount=0, fin=null;

    try{
      const b = await launchBrowser();
      const page = await b.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');

      try{
        fin = await scrapeFintechAverages(page);
        bidAvg = fin.bidAvg; askAvg = fin.askAvg; sampleCount = fin.sampleCount;
        console.log(`✅ Fintech: ${sampleCount} | BidAvg=${bidAvg?.toFixed?.(4)} | AskAvg=${askAvg?.toFixed?.(4)}`);
      }catch(e){ console.error('❌ Fintech:', e.message); }

      try{
        spot = await scrapeBloombergSpot(page);
        console.log(`✅ Bloomberg Spot: ${Number.isFinite(spot)?spot:'NaN'}`);
      }catch(e){ console.error('❌ Bloomberg:', e.message); }

      await page.close().catch(()=>{});
    }catch(e){
      console.error('💥 Error general tick:', e);
    }

    let bestBuy=null, bestSell=null;
    if (fin && Array.isArray(fin.raw) && fin.raw.length){
      bestBuy  = fin.raw.map(f => ({name:f.name, buy:  parseNum(f.sell)}))
                        .filter(f => Number.isFinite(f.buy)  && f.buy>0)
                        .sort((a,b)=>a.buy-b.buy)[0] || null;
      bestSell = fin.raw.map(f => ({name:f.name, sell: parseNum(f.buy)}))
                        .filter(f => Number.isFinite(f.sell) && f.sell>0)
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
    liveSeries = liveSeries.filter(p => (p.timestamp||p.ts).split('T')[0] === today);
    liveSeries.push(point);
    if (liveSeries.length > 2000) liveSeries.shift();

    io.emit('tick', point);
  }

  await runOnce();
  setInterval(runOnce, REFRESH_MS);

  app.get('/api/health', (_,res)=>res.json({ok:true, size:liveSeries.length}));

  server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
})();

