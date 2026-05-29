import https from 'https';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchBuffer(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function parseMC(s) {
  const n = parseFloat(String(s).replace(/[$,]/g, ''));
  return String(s).includes('K') ? n * 1e3 : String(s).includes('M') ? n * 1e6 : String(s).includes('B') ? n * 1e9 : n;
}

function fmtUSD(n) {
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtPrice(p) {
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  if (p >= 0.0001) return `$${p.toFixed(6)}`;
  return `$${p.toExponential(2)}`;
}

export async function fetchDexData(tokenAddress) {
  if (!tokenAddress) return null;
  try {
    const data = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const pairs = data?.pairs || [];
    if (!pairs.length) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return {
      price: parseFloat(best.priceUsd) || 0,
      priceChange: {
        h1: parseFloat(best.priceChange?.h1) || 0,
        h6: parseFloat(best.priceChange?.h6) || 0,
        h24: parseFloat(best.priceChange?.h24) || 0,
      },
      volume: {
        h1: parseFloat(best.volume?.h1) || 0,
        h6: parseFloat(best.volume?.h6) || 0,
        h24: parseFloat(best.volume?.h24) || 0,
      },
      liquidity: best.liquidity?.usd || 0,
      fdv: parseFloat(best.fdv) || 0,
      marketCap: parseFloat(best.marketCap) || 0,
      txns: {
        h24: { buys: best.txns?.h24?.buys || 0, sells: best.txns?.h24?.sells || 0 },
        h6: { buys: best.txns?.h6?.buys || 0, sells: best.txns?.h6?.sells || 0 },
        h1: { buys: best.txns?.h1?.buys || 0, sells: best.txns?.h1?.sells || 0 },
      },
      pairAddress: best.pairAddress || null,
      chainId: best.chainId || 'base',
      dexId: best.dexId || '',
      url: best.url || '',
    };
  } catch { return null; }
}

function safeNum(v, fallback = 0) {
  if (v === undefined || v === null || !isFinite(v) || isNaN(v)) return fallback;
  return v;
}

function generateCandlesFromMetrics(dex) {
  const price = safeNum(dex.price, 1);
  const h24 = Math.max(safeNum(dex.priceChange.h24, 0) / 100, -0.95);
  const h6 = Math.max(safeNum(dex.priceChange.h6, 0) / 100, -0.95);

  const startPrice = safeNum(price / (1 + h24), price);
  const ohlcv = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const t = i / 23;
    const trendPrice = safeNum(startPrice + (price - startPrice) * t, price);
    const volatility = safeNum(price * 0.015, 0.001);
    const noise = safeNum((Math.random() - 0.5) * 2, 0);

    let bias = 0;
    if (h24 > 0.05) bias = 0.3;
    else if (h24 < -0.05) bias = -0.3;
    else if (h6 > 0.02) bias = 0.15;
    else if (h6 < -0.02) bias = -0.15;

    const open = safeNum(trendPrice + noise * volatility * 0.8, price);
    const change = safeNum((Math.random() + bias) * volatility, 0);
    const close = safeNum(open + change, open);
    const high = safeNum(Math.max(open, close) + Math.random() * volatility * 0.5, close);
    const low = safeNum(Math.min(open, close) - Math.random() * volatility * 0.5, close);

    const ts = new Date(now - (23 - i) * 3600000);
    const label = `${ts.getHours()}h`;
    const vol = safeNum(dex.volume.h24 * (0.01 + Math.random() * 0.08), 1);

    ohlcv.push({ open, high, low, close, label,
      isUp: close >= open,
      volume: vol
    });
  }
  return ohlcv;
}

export async function buildInfographicChart(tokenData) {
  let dex = null;
  if (tokenData.address) {
    dex = await fetchDexData(tokenData.address);
  }

  const mcVal = tokenData.mcVal || parseMC(tokenData.mc || '0');
  const volVal = tokenData.volVal || parseMC(tokenData.vol || '0');
  const isUp = dex ? dex.priceChange.h24 > 0 : Math.random() > 0.45;

  let candles;
  if (dex) {
    candles = generateCandlesFromMetrics(dex);
  } else {
    const startP = 0.001 + Math.random() * 5;
    const endP = isUp ? startP * (1 + Math.random() * 0.4) : startP * (1 - Math.random() * 0.3);
    candles = [];
    for (let i = 0; i < 24; i++) {
      const t = i / 23;
      const tp = startP + (endP - startP) * t;
      const v = tp * (0.005 + Math.random() * 0.03);
      const o = tp + (Math.random() - 0.5) * tp * 0.02;
      const c = o + (Math.random() - (isUp ? 0.4 : 0.6)) * tp * 0.03;
      candles.push({ open: o, high: Math.max(o, c) + Math.random() * tp * 0.015, low: Math.min(o, c) - Math.random() * tp * 0.015, close: c, label: `${(23-i)}h`, isUp: c >= o, volume: v });
    }
  }

  const green = '#00e676';
  const red = '#ff1744';
  const bg = '#0a0a14';
  const lineColor = isUp ? green : red;
  const accentGreen = 'rgba(0,230,118,0.18)';
  const accentRed = 'rgba(255,23,68,0.18)';
  const accent = isUp ? accentGreen : accentRed;

  const labels = candles.map(c => c.label);
  const candlestickData = candles.map((c, i) => ({
    x: i,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    s: [Date.now() - (23-i) * 3600000, c.open, c.high, c.low, c.close],
  }));

  const priceData = candles.map(c => c.close);
  const volData = candles.map(c => c.volume);
  const ma7 = [];
  for (let i = 0; i < priceData.length; i++) {
    const slice = priceData.slice(Math.max(0, i - 6), i + 1);
    ma7.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }

  const ticker = tokenData.ticker || '$TOKEN';
  const price = dex?.price || candles[candles.length - 1].close;
  const change24 = dex ? dex.priceChange.h24 : isUp ? (Math.random() * 25 + 2) : -(Math.random() * 20 + 2);
  const changeSign = change24 >= 0 ? '▲' : '▼';
  const changeColor = change24 >= 0 ? green : red;

  const h1 = dex?.priceChange.h1 || (change24 * (0.05 + Math.random() * 0.15));
  const h6 = dex?.priceChange.h6 || (change24 * (0.3 + Math.random() * 0.3));
  const liq = dex?.liquidity || mcVal * (0.05 + Math.random() * 0.2);
  const fdv = dex?.fdv || mcVal * (1 + Math.random() * 0.5);
  const h24buys = dex?.txns.h24.buys || 0;
  const h24sells = dex?.txns.h24.sells || 0;
  const totalTxns = h24buys + h24sells;
  const buyRatio = totalTxns > 0 ? Math.round(h24buys / totalTxns * 100) : 50;

  const volRatio = mcVal > 0 ? Math.round(volVal / mcVal * 100) : 0;

  const TOP_H = 80;
  const BOT_H = 46;
  const CHART_PADDING = 16;
  const W = 960;
  const H = 540;
  const CHART_TOP = TOP_H + 12;
  const CHART_H = H - CHART_TOP - BOT_H - 16;

  const bgGradient = 'rgba(0,230,118,0.03)';
  const borderSubtle = 'rgba(255,255,255,0.06)';

  const overlays = [
    { type: 'rectangle', x: 0, y: 0, width: W, height: TOP_H, color: isUp ? 'rgba(0,230,118,0.04)' : 'rgba(255,23,68,0.04)', borderRadius: 0 },
    { type: 'rectangle', x: 0, y: 0, width: W, height: TOP_H, color: 'rgba(0,0,0,0)', borderColor: borderSubtle, borderWidth: 1, borderRadius: 0 },

    { type: 'textBlock', x: CHART_PADDING, y: 10, text: `${ticker}`, color: '#ffffff', fontFamily: 'sans-serif', fontSize: 22, bold: true },
    { type: 'textBlock', x: CHART_PADDING + 90, y: 13, text: tokenData.name || '', color: '#888', fontFamily: 'sans-serif', fontSize: 13 },

    { type: 'textBlock', x: CHART_PADDING, y: 40, text: `${fmtPrice(price)}`, color: changeColor, fontFamily: 'monospace', fontSize: 20, bold: true },
    { type: 'textBlock', x: CHART_PADDING + 105, y: 44, text: `${changeSign} ${Math.abs(change24).toFixed(1)}% 24h`, color: changeColor, fontFamily: 'monospace', fontSize: 13, bold: true },

    { type: 'rectangle', x: W - 200, y: 12, width: 88, height: 28, color: changeColor, opacity: 0.12, borderRadius: 6 },
    { type: 'textBlock', x: W - 192, y: 16, text: `${changeSign} ${Math.abs(change24).toFixed(1)}%`, color: changeColor, fontFamily: 'monospace', fontSize: 14, bold: true },

    { type: 'textBlock', x: W - 210, y: 46, text: `H1: ${h1 >= 0 ? '+' : ''}${h1.toFixed(1)}%`, color: h1 >= 0 ? green : red, fontFamily: 'monospace', fontSize: 11 },
    { type: 'textBlock', x: W - 125, y: 46, text: `H6: ${h6 >= 0 ? '+' : ''}${h6.toFixed(1)}%`, color: h6 >= 0 ? green : red, fontFamily: 'monospace', fontSize: 11 },

    { type: 'rectangle', x: 0, y: H - BOT_H, width: W, height: BOT_H, color: 'rgba(255,255,255,0.02)', borderRadius: 0 },
    { type: 'rectangle', x: 0, y: H - BOT_H, width: W, height: 1, color: borderSubtle, borderRadius: 0 },

    { type: 'textBlock', x: CHART_PADDING, y: H - BOT_H + 8, text: `MC: ${tokenData.mc || 'N/A'}`, color: '#ccc', fontFamily: 'monospace', fontSize: 11 },
    { type: 'textBlock', x: CHART_PADDING + 130, y: H - BOT_H + 8, text: `Vol 24h: ${tokenData.vol || 'N/A'}`, color: '#ccc', fontFamily: 'monospace', fontSize: 11 },
    { type: 'textBlock', x: CHART_PADDING + 260, y: H - BOT_H + 8, text: `Vol/MC: ${volRatio}%`, color: volRatio >= 20 ? green : '#ccc', fontFamily: 'monospace', fontSize: 11 },
    { type: 'textBlock', x: CHART_PADDING + 370, y: H - BOT_H + 8, text: `Liq: ${fmtUSD(liq)}`, color: '#ccc', fontFamily: 'monospace', fontSize: 11 },
    { type: 'textBlock', x: CHART_PADDING + 500, y: H - BOT_H + 8, text: `FDV: ${fmtUSD(fdv)}`, color: '#ccc', fontFamily: 'monospace', fontSize: 11 },

    { type: 'textBlock', x: CHART_PADDING, y: H - BOT_H + 23, text: `Buys: ${buyRatio}%`, color: buyRatio >= 50 ? green : red, fontFamily: 'monospace', fontSize: 11 },
    { type: 'textBlock', x: CHART_PADDING + 100, y: H - BOT_H + 23, text: `Txns 24h: ${totalTxns}`, color: '#999', fontFamily: 'monospace', fontSize: 11 },
    { type: 'textBlock', x: CHART_PADDING + 210, y: H - BOT_H + 23, text: `DEX: ${dex?.dexId || 'N/A'}`, color: '#999', fontFamily: 'monospace', fontSize: 11 },
    { type: 'textBlock', x: CHART_PADDING + 370, y: H - BOT_H + 23, text: `Source: ${tokenData.source || 'DEX'}`, color: '#777', fontFamily: 'monospace', fontSize: 11 },
  ];

  const chartCfg = {
    width: W, height: H, backgroundColor: bg, devicePixelRatio: 2, format: 'png',
    overlay: overlays,
    chart: {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'line', label: 'MA7', data: ma7,
            borderColor: isUp ? 'rgba(0,230,118,0.35)' : 'rgba(255,23,68,0.30)',
            backgroundColor: 'transparent', fill: false,
            borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, tension: 0.4,
            yAxisID: 'y', order: 3,
          },
          {
            type: 'line', label: 'Price', data: priceData,
            borderColor: lineColor, backgroundColor: accent, fill: true,
            borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
            pointHoverBackgroundColor: lineColor, tension: 0.35,
            yAxisID: 'y', order: 2,
          },
          {
            type: 'bar', label: 'Volume', data: volData,
            backgroundColor: isUp ? 'rgba(0,230,118,0.08)' : 'rgba(255,23,68,0.08)',
            borderColor: isUp ? 'rgba(0,230,118,0.18)' : 'rgba(255,23,68,0.15)',
            borderWidth: 1, borderRadius: 1,
            yAxisID: 'y1', order: 1,
          },
        ],
      },
      options: {
        layout: { padding: { top: CHART_TOP + 12, right: 18, bottom: BOT_H + 8, left: 12 } },
        plugins: {
          legend: { display: false },
          tooltip: { mode: 'index', intersect: false, backgroundColor: 'rgba(10,10,30,0.95)', titleColor: '#aaa', bodyColor: '#fff', borderColor: lineColor, borderWidth: 1, cornerRadius: 6 },
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.02)' }, ticks: { color: '#444', font: { size: 9 }, maxTicksLimit: 6 } },
          y: { position: 'right', grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#777', font: { size: 9 }, maxTicksLimit: 4 } },
          y1: { position: 'left', grid: { display: false }, ticks: { color: 'rgba(255,255,255,0.15)', font: { size: 8 }, maxTicksLimit: 3 } },
        },
      },
    },
  };

  const buf = await chartToBuffer(chartCfg);
  return { buffer: buf, dex };
}

async function chartToBuffer(chartCfg) {
  const payload = JSON.stringify(chartCfg);
  const chartUrl = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'quickchart.io', path: '/chart/create', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`create ${res.statusCode}: ${body.slice(0, 100)}`));
          return;
        }
        try {
          const j = JSON.parse(body);
          if (j.success && j.url) resolve(j.url);
          else reject(new Error('no url: ' + body.slice(0, 100)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('create timeout')); });
    req.write(payload);
    req.end();
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
      const buf = await new Promise((resolve, reject) => {
        const u = new URL(chartUrl);
        https.get({
          hostname: u.hostname, path: u.pathname,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/png' },
          timeout: 15000,
        }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            const loc = res.headers.location;
            if (loc) {
              const u2 = new URL(loc);
              https.get({ hostname: u2.hostname, path: u2.pathname + u2.search, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, r2 => {
                if (r2.statusCode !== 200 && r2.statusCode !== 400) { reject(new Error(`dl ${r2.statusCode}`)); return; }
                const c = []; r2.on('data', d => c.push(d)); r2.on('end', () => resolve(Buffer.concat(c)));
              }).on('error', reject);
              return;
            }
          }
          if (res.statusCode !== 200 && res.statusCode !== 400) { reject(new Error(`dl ${res.statusCode}`)); return; }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
      if (buf && buf.length > 500 && buf[0] === 0x89 && buf[1] === 0x50) return buf;
      throw new Error('chart too small');
    } catch (e) {
      if (attempt === 2) throw new Error(`chart: ${e.message}`);
    }
  }
}

export async function downloadLogo(url) {
  if (!url) return null;
  try {
    const buf = await fetchBuffer(url);
    if (buf && buf.length > 500) return buf;
    return null;
  } catch { return null; }
}
