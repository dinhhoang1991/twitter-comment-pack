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

function parseMC(s) {
  const n = parseFloat(s.replace(/[$,]/g, ''));
  return s.includes('K') ? n * 1e3 : s.includes('M') ? n * 1e6 : s.includes('B') ? n * 1e9 : n;
}

async function fetchGeckoTrending(chain = 'base') {
  try {
    const data = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${chain}/trending_pools?page=1`);
    const pools = data?.data || [];
    return pools.map(p => {
      const attrs = p.attributes || {};
      const mc = parseFloat(attrs.market_cap_usd) || 0;
      const vol24 = parseFloat((attrs.volume_usd || {}).h24) || 0;
      const nameRaw = attrs.name || '';
      const pair = nameRaw.split(' / ')[0];
      const parts = pair.split(' ');
      const symbol = parts[parts.length - 1] || pair;
      const name = parts.length > 1 ? parts.slice(0, -1).join(' ') : symbol;
      return {
        ticker: '$' + symbol.toUpperCase(),
        name,
        mc: mc >= 1e6 ? `$${(mc/1e6).toFixed(2)}M` : mc >= 1e3 ? `$${(mc/1e3).toFixed(1)}K` : `$${mc.toFixed(0)}`,
        vol: vol24 >= 1e6 ? `$${(vol24/1e6).toFixed(2)}M` : vol24 >= 1e3 ? `$${(vol24/1e3).toFixed(1)}K` : `$${vol24.toFixed(0)}`,
        mcVal: mc,
        volVal: vol24,
        source: 'geckoterminal',
        chain
      };
    }).filter(t => t.mcVal > 0);
  } catch (e) {
    return [];
  }
}

async function fetchClankerTokens() {
  try {
    const data = await fetchJSON('https://www.clanker.world/api/tokens?page=1');
    const tokens = data?.data || [];
    return tokens.slice(0, 20).map(t => ({
      ticker: '$' + (t.symbol || 'TOKEN').toUpperCase(),
      name: t.name || t.symbol || 'Unknown',
      mc: 'N/A',
      vol: 'N/A',
      mcVal: 0,
      volVal: 0,
      source: 'clanker',
      chain: 'base',
      address: t.contract_address
    }));
  } catch (e) {
    return [];
  }
}

async function fetchBankrTokens() {
  const rows = [];
  let page = 0;
  while (rows.length < 30 && page < 3) {
    try {
      const data = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/base/pools?page=${page + 1}&include=base_token`);
      const pools = data?.data || [];
      for (const p of pools) {
        const attrs = p.attributes || {};
        const name = attrs.name || '';
        if (!name.toLowerCase().includes('/weth')) continue;
        const mc = parseFloat(attrs.market_cap_usd) || 0;
        if (mc < 100_000 || mc > 10_000_000) continue;
        const vol24 = parseFloat((attrs.volume_usd || {}).h24) || 0;
        const symbol = name.split(' / ')[0].split(' ').pop().toUpperCase();
        rows.push({
          ticker: '$' + symbol,
          name: name.split(' / ')[0],
          mc: mc >= 1e6 ? `$${(mc/1e6).toFixed(2)}M` : `$${(mc/1e3).toFixed(1)}K`,
          vol: vol24 >= 1e6 ? `$${(vol24/1e6).toFixed(2)}M` : (vol24 >= 1e3 ? `$${(vol24/1e3).toFixed(1)}K` : `$${vol24.toFixed(0)}`),
          mcVal: mc,
          volVal: vol24,
          source: 'gecko-base',
          chain: 'base'
        });
      }
      page++;
    } catch (e) { break; }
  }
  return rows;
}

async function fetchBankrAgents() {
  try {
    const data = await fetchJSON('https://api.bankr.bot/agent-profiles?sort=marketCap&limit=30');
    const profiles = data?.profiles || [];
    return profiles.map(p => ({
      ticker: '$' + (p.tokenSymbol || 'TOKEN').toUpperCase(),
      name: p.tokenName || p.projectName || 'Unknown',
      mc: p.marketCapUsd >= 1e6 ? `$${(p.marketCapUsd/1e6).toFixed(2)}M` : `$${(p.marketCapUsd/1e3).toFixed(1)}K`,
      vol: 'N/A',
      mcVal: p.marketCapUsd || 0,
      volVal: 0,
      source: 'bankr',
      chain: p.tokenChainId || 'base',
      img: p.profileImageUrl || null,
      revenue: p.weeklyRevenueWeth || null,
      address: p.tokenAddress || null
    }));
  } catch (e) {
    return [];
  }
}

export async function scrapeTokens(cfg = {}) {
  const minMC = cfg.minMC || 100_000;
  const maxMC = cfg.maxMC || 7_000_000;
  const minVolRatio = cfg.minVolRatio || 0.03;

  const [trending, clankerTokens, basePools, bankrAgents] = await Promise.all([
    fetchGeckoTrending('base'),
    fetchClankerTokens(),
    fetchBankrTokens(),
    fetchBankrAgents()
  ]);

  const seen = new Set();
  const all = [];

  for (const t of bankrAgents) {
    const key = t.ticker.toLowerCase();
    if (seen.has(key)) continue;
    if (t.mcVal < minMC || t.mcVal > maxMC) continue;
    seen.add(key);
    all.push(t);
  }

  for (const t of [...trending, ...basePools]) {
    const key = t.ticker.toLowerCase();
    if (seen.has(key)) continue;
    if (t.mcVal < minMC || t.mcVal > maxMC) continue;
    const ratio = t.mcVal > 0 ? t.volVal / t.mcVal : 0;
    if (ratio < minVolRatio) continue;
    seen.add(key);
    all.push(t);
  }

  for (const t of clankerTokens) {
    const key = t.ticker.toLowerCase();
    if (seen.has(key) || all.length >= 30) break;
    seen.add(key);
    all.push({ ...t, mc: 'N/A', vol: 'N/A' });
  }

  return all.length > 0 ? all : null;
}
