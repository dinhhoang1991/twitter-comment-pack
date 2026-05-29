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

function parseMC(s) {
  const n = parseFloat(String(s).replace(/[$,]/g, ''));
  return String(s).includes('K') ? n * 1e3 : String(s).includes('M') ? n * 1e6 : String(s).includes('B') ? n * 1e9 : n;
}

export async function scoreToken(token) {
  let score = 0;
  const reasons = [];

  const mcVal = token.mcVal || parseMC(token.mc || '0');
  const volVal = token.volVal || parseMC(token.vol || '0');

  if (mcVal >= 100_000 && mcVal <= 7_000_000) {
    if (mcVal >= 500_000 && mcVal <= 3_000_000) { score += 30; reasons.push('MC: sweet spot'); }
    else if (mcVal < 500_000) { score += 15; reasons.push('MC: micro cap'); }
    else { score += 20; reasons.push('MC: mid cap'); }
  }

  if (volVal > 0 && mcVal > 0) {
    const ratio = volVal / mcVal;
    if (ratio >= 0.5) { score += 40; reasons.push(`vol/MC: ${(ratio*100).toFixed(0)}% 🔥`); }
    else if (ratio >= 0.1) { score += 25; reasons.push(`vol/MC: ${(ratio*100).toFixed(0)}%`); }
    else if (ratio >= 0.03) { score += 12; reasons.push(`vol/MC: ${(ratio*100).toFixed(0)}%`); }
  }

  if (token.source === 'bankr') { score += 20; reasons.push('source: Bankr.bot'); }
  else if (token.source === 'geckoterminal') { score += 12; reasons.push('source: GeckoTerminal'); }
  else if (token.source === 'gecko-base') { score += 8; reasons.push('source: Base pool'); }

  if (token.img) { score += 10; reasons.push('has logo'); }

  if (token.revenue && token.revenue > 0) { score += 15; reasons.push('has revenue'); }

  if (token.address) { score += 5; }

  const name = (token.name || token.ticker || '').toLowerCase();
  const badWords = ['scam', 'rug', 'test', 'fake', 'honeypot', 'dead', 'ponzi'];
  if (badWords.some(w => name.includes(w))) { score -= 50; reasons.push('⚠️ suspicious name'); }

  try {
    if (token.address) {
      const dexData = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`);
      const bestPair = (dexData?.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      if (bestPair) {
        const liq = bestPair.liquidity?.usd || 0;
        const priceChange = bestPair.priceChange || {};
        const h24 = parseFloat(priceChange.h24) || 0;
        const h6 = parseFloat(priceChange.h6) || 0;
        const txns = (bestPair.txns || {});

        if (liq > 50000) { score += 25; reasons.push(`liq: $${(liq/1000).toFixed(0)}K`); }
        else if (liq > 10000) { score += 15; reasons.push(`liq: $${(liq/1000).toFixed(0)}K`); }
        else if (liq > 1000) { score += 5; }

        const buys = (txns.h24?.buys || 0) + (txns.h6?.buys || 0);
        const sells = (txns.h24?.sells || 0) + (txns.h6?.sells || 0);
        const totalTxns = buys + sells;
        if (totalTxns > 0 && buys > sells * 1.5) { score += 15; reasons.push('buy pressure'); }
        else if (totalTxns > 0 && buys > sells) { score += 8; reasons.push('slight buy bias'); }

        if (h24 > 20) { score += 15; reasons.push(`24h: +${h24.toFixed(0)}%`); }
        else if (h24 > 5) { score += 8; reasons.push(`24h: +${h24.toFixed(0)}%`); }
        else if (h24 < -20) { score -= 10; reasons.push(`24h: ${h24.toFixed(0)}%`); }

        if (h6 > 10 && Math.abs(h24) < 15) { score += 10; reasons.push('recent momentum'); }
      }
    }
  } catch {}

  return { score, reasons, token };
}

export async function pickBestToken(tokens, log) {
  if (!tokens || !tokens.length) return null;

  const withMC = tokens.filter(t => {
    const mc = t.mcVal || parseMC(t.mc || '0');
    return mc >= 100_000 && mc <= 7_000_000;
  });
  const pool = withMC.length ? withMC : tokens;
  const topCandidates = pool.slice(0, 15);

  const scored = [];
  for (const t of topCandidates) {
    try {
      const result = await scoreToken(t);
      scored.push(result);
    } catch {}
  }

  if (!scored.length) return pool[Math.floor(Math.random() * pool.length)];

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (log) {
    log(`[auto-post] scored ${scored.length} tokens | top: ${best.token.ticker}(${best.token.name}) score=${best.score} | ${best.reasons.slice(0, 4).join(', ')}`);
    if (scored.length > 1) {
      const second = scored[1];
      log(`[auto-post] runner-up: ${second.token.ticker}(${second.token.name}) score=${second.score} | ${second.reasons.slice(0, 3).join(', ')}`);
    }
  }

  return best.token;
}
