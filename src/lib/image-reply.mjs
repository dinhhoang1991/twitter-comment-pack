import https from 'https';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
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
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
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

const CRYPTO_KEYWORDS = ['crypto','bitcoin','ethereum','solana','btc','eth','sol','defi','nft','token','meme','airdrop','blockchain','web3','dex','base','chain','coin','bull','bear','pump','dump','moon','ath','trading','chart','holder','trader'];

function extractSymbol(text) {
  const lower = text.toLowerCase();
  const tickerMatch = text.match(/\$([A-Za-z]{2,10})\b/g);
  if (tickerMatch) return tickerMatch[0].replace('$', '').toUpperCase();
  for (const kw of CRYPTO_KEYWORDS) {
    if (lower.includes(kw)) return kw.toUpperCase();
  }
  return 'CRYPTO';
}

export async function generateReplyChart(tweetText) {
  const symbol = extractSymbol(tweetText);
  const isBull = /bull|pump|moon|buy|long|green|tăng|lên/g.test(tweetText.toLowerCase());
  const isBear = /bear|dump|crash|sell|short|red|giảm|sập/g.test(tweetText.toLowerCase());
  const trend = isBull ? 'up' : isBear ? 'down' : Math.random() > 0.5 ? 'up' : 'down';

  const startPrice = 0.01 + Math.random() * 10;
  const endPrice = trend === 'up' ? startPrice * (1 + Math.random() * 0.4) : startPrice * (1 - Math.random() * 0.3);
  const lineColor = trend === 'up' ? '#00ffcc' : '#ff4466';
  const fillColor = trend === 'up' ? 'rgba(0,255,204,0.15)' : 'rgba(255,68,102,0.15)';

  const hours = Array.from({length: 12}, (_, i) => `${11-i}h`);
  const prices = [];
  for (let i = 0; i < 12; i++) {
    const t = i / 11;
    const base = startPrice + (endPrice - startPrice) * t;
    prices.push(base + (Math.random() - 0.5) * startPrice * 0.1);
  }

  const chartCfg = {
    width: 600, height: 300, backgroundColor: '#0d0d1a', devicePixelRatio: 2, format: 'png',
    chart: {
      type: 'line',
      data: {
        labels: hours,
        datasets: [{
          data: prices, borderColor: lineColor, backgroundColor: fillColor,
          fill: true, borderWidth: 2, pointRadius: 0, tension: 0.4
        }]
      },
      options: {
        layout: { padding: { top: 30, right: 10, bottom: 5, left: 10 } },
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#444', font: { size: 9 }, maxTicksLimit: 4 } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#666', font: { size: 9 }, maxTicksLimit: 4 } }
        }
      }
    }
  };

  const payload = JSON.stringify(chartCfg);
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'quickchart.io', path: '/chart/create', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000
    }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`chart HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString());
          if (j.success && j.url) resolve(j.url);
          else reject(new Error('no url'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });

  return await fetchBuffer(result);
}

export async function fetchMemeGIF(sentiment) {
  const query = sentiment === 'bullish' ? 'crypto moon pump' :
    sentiment === 'bearish' ? 'crypto crash dump' :
    sentiment === 'question' ? 'confused crypto' : 'trading crypto';
  try {
    const data = await fetchJSON(`https://g.tenor.com/v1/search?q=${encodeURIComponent(query)}&key=LIVDSRZULELA&limit=5&media_filter=minimal`);
    const results = data?.results || [];
    if (!results.length) return null;
    const pick = results[Math.floor(Math.random() * results.length)];
    const gifUrl = pick?.media?.[0]?.gif?.url || pick?.media?.[0]?.tinygif?.url;
    if (!gifUrl) return null;
    return await fetchBuffer(gifUrl);
  } catch { return null; }
}

export async function generateReplyImage(tweetText, type = 'chart') {
  if (type === 'meme') return await fetchMemeGIF(tweetText);
  return await generateReplyChart(tweetText);
}
