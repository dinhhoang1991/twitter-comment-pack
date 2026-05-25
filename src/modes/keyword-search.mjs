import { searchTimeline, postTweet, favoriteTweet, followUser, unfollowUser, uploadMedia } from '../lib/twitter-http.mjs';
import { generateComment, selectPersona } from '../lib/ai-commenter.mjs';
import { detectLanguage } from '../lib/language.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { scrapeTokens } from '../lib/token-scraper.mjs';
import { getCommentCount, markCommented, isEngagedUser, markUserEngaged,
         seeViralTweet, getViralTweets, cleanupOldViralTweets, getViralStats,
         trackFollow, getStaleFollows, removeFollowRecord,
         isMutual, markMutual, getMutuals, getMutualCount,
         isFollowing,
         getTrendKeywords, bumpTrendWord, cleanupTrendWords,
         getMeta, setMeta, trackMyReply, isReplyToMyComment } from '../lib/store.mjs';
import { getFriendship } from '../lib/twitter-http.mjs';
import { waitForSlot } from '../lib/rate-limiter.mjs';
import { sendAlert } from '../lib/telegram.mjs';

function isUserRepliedToday(username) {
  const today = new Date().toDateString();
  const day = getMeta('replied_day');
  if (day !== today) { setMeta('replied_day', today); setMeta('replied_users', ''); return false; }
  const list = (getMeta('replied_users') || '').split(',').filter(Boolean);
  return list.includes(username);
}

function markUserRepliedToday(username) {
  const list = (getMeta('replied_users') || '').split(',').filter(Boolean);
  list.push(username);
  setMeta('replied_users', list.slice(-200).join(','));
}

const ENGAGEMENT_STYLES = ['question','insight','humor','support','hot-take'];
let _styleIdx = 0;
function pickEngagementStyle() {
  const style = ENGAGEMENT_STYLES[_styleIdx % ENGAGEMENT_STYLES.length];
  _styleIdx++;
  return style;
}
const STYLE_HINTS = {
  'question': 'End with a genuine question that invites discussion.',
  'insight': 'Share a sharp observation or analysis. Be knowledgeable.',
  'humor': 'Be witty or slightly sarcastic. Make them smile.',
  'support': 'Be encouraging and positive. Lift them up.',
  'hot-take': 'Drop a bold opinion. Be slightly controversial but not offensive.',
};

function trackStat(key) {
  const today = new Date().toDateString();
  const day = getMeta('stat_day');
  if (day !== today) {
    setMeta('stat_day', today);
    setMeta('stat_replies', '0');
    setMeta('stat_likes', '0');
    setMeta('stat_follows', '0');
    setMeta('stat_autoposts', '0');
  }
  const current = parseInt(getMeta(key) || '0');
  setMeta(key, String(current + 1));
}

async function sendDailyReportIfTime(cfg, log) {
  const now = new Date();
  const hour = now.getHours();
  const today = now.toDateString();
  const sent = getMeta('report_sent_day');
  if (sent === today || hour < 22) return;
  if (hour >= 22 && cfg.telegram?.botToken) {
    const replies = parseInt(getMeta('stat_replies') || '0');
    const likes = parseInt(getMeta('stat_likes') || '0');
    const follows = parseInt(getMeta('stat_follows') || '0');
    const autoposts = parseInt(getMeta('stat_autoposts') || '0');
    const total = replies + likes + follows + autoposts;
    if (total === 0) return;
    try {
      await sendAlert(cfg.telegram.botToken, cfg.telegram.chatId,
        `📊 Daily Report ${today}\n` +
        `💬 Replies: ${replies}\n` +
        `❤️ Likes: ${likes}\n` +
        `👥 Follows: ${follows}\n` +
        `📝 Auto-posts: ${autoposts}\n` +
        `━━━━━━━━━━━━━\n` +
        `🔥 Total actions: ${total}`);
      setMeta('report_sent_day', today);
    } catch {}
  }
}
const MAX_AGE_MS = 15 * 60 * 1000;

async function retry(fn, maxAttempts = 3, delayMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); }
    catch (e) { if (i === maxAttempts - 1) throw e; await new Promise(r => setTimeout(r, delayMs * (i + 1))); }
  }
}
const VN_DIACRITICS = /[ăâêôơưđ]/i;
const VN_PHRASES = ['cày x', 'cày airdrop', 'build x', 'pay x', 'xây kênh', 'hold lâu', 'lên giá', 'sàn crypto', 'token mới', 'săn airdrop'];
function isVNQuery(q) {
  if (VN_DIACRITICS.test(q)) return true;
  const lower = q.toLowerCase();
  return VN_PHRASES.some(p => lower.includes(p));
}
function getVietnamHour() {
  return (new Date().getUTCHours() + 7) % 24;
}

function getSmartDelay() {
  const h = getVietnamHour();
  const isPeak = (h >= 8 && h <= 11) || (h >= 19 && h <= 23);
  const base = isPeak ? 4000 : 12000;
  const spread = isPeak ? 3000 : 8000;
  return base + Math.random() * spread;
}

export async function runKeywordSearchMode(cfg, log) {
  if (typeof log !== 'function') log = console.log;
  const modeCfg = cfg.modeD || {};
  const hashtags = modeCfg.hashtags || ['#Crypto', '#Bitcoin', '#Airdrop', '#Solana', '#Base'];
  const keywords = modeCfg.keywords || ['airdrop', 'bullish', 'moon', 'gem', 'alpha'];
  const maxPerCycle = modeCfg.maxTweetsPerCycle || 15;
  const onlyEngaged = modeCfg.onlyEngagedUsers === true;
  const autoLike = modeCfg.autoLike !== false;
  const autoFollow = modeCfg.autoFollow === true || modeCfg.autoFollow === 'true';
  const enableAutoPost = modeCfg.enableAutoPost === true;
  const autoPostChance = modeCfg.autoPostChance || 0.25;
  const minLikes = modeCfg.minLikes !== undefined ? modeCfg.minLikes : 5;
  const minReplies = modeCfg.minReplies !== undefined ? modeCfg.minReplies : 1;
  const minFollowers = modeCfg.minFollowers !== undefined ? modeCfg.minFollowers : 1000;
  const highFollowerMin = modeCfg.highFollowerMin !== undefined ? modeCfg.highFollowerMin : 50000;
  const prioritizeHighFollowers = modeCfg.prioritizeHighFollowers === true;
  const onlyVerified = modeCfg.onlyVerified === true;
  const enableThread = modeCfg.enableThread === true;
  const minAccountAgeDays = modeCfg.minAccountAgeDays || 0;
  const blacklistWords = modeCfg.blacklistWords || [];
  const personas = modeCfg.personas || [];
  const autoUnfollowDays = modeCfg.autoUnfollowDays || 3;
  const backfillLikeCount = modeCfg.backfillLikeCount || 0;
  const threadHijackMinReplies = modeCfg.threadHijackMinReplies || 0;
  const trendSurfingEnabled = modeCfg.trendSurfingEnabled === true;
  const trendSurfingMinMentions = modeCfg.trendSurfingMinMentions || 3;
  const smartConnectionsEnabled = modeCfg.smartConnectionsEnabled === true;
  const mutualCheckInterval = modeCfg.mutualCheckIntervalCycles || 5;
  const competitorReplyChance = modeCfg.competitorReplyChance || 0;

  let queries = [...hashtags, ...keywords];

  cleanupTrendWords();
  if (trendSurfingEnabled) {
    const trends = getTrendKeywords();
    const trendWords = trends.filter(t => t.cnt >= trendSurfingMinMentions).map(t => t.word);
    if (trendWords.length) {
      queries = [...trendWords, ...queries];
      log(`[trend] ${trendWords.length} trending: ${trendWords.join(', ')}`);
    }
  }

  const mutualIds = new Set();
  if (smartConnectionsEnabled) {
    const cycleNum = parseInt(getMeta('cycle_count') || '0') + 1;
    setMeta('cycle_count', String(cycleNum));
    const mutuals = getMutuals();
    mutuals.forEach(m => mutualIds.add(m.user_id));
    if (mutuals.length) log(`[mutual] ${mutuals.length} mutuals tracked`);
    if (cycleNum % mutualCheckInterval === 0) {
      const follows = getStaleFollows(0);
      let checked = 0, newMutuals = 0;
      for (const f of follows) {
        if (checked >= 10) break;
        try {
          const fs = await getFriendship(f.username, cfg.cookiesFile);
          if (fs?.relationship?.source?.followed_by) {
            markMutual(f.user_id, f.username);
            newMutuals++;
          }
          checked++;
        } catch {}
      }
      if (newMutuals) {
        log(`[mutual] ${newMutuals} new mutuals discovered`);
        for (const m of getMutuals().slice(0, 3)) {
          try {
            const mtweets = await searchTimeline(`from:@${m.username}`, cfg.cookiesFile, null, 'Latest');
            const toLike = (mtweets?.tweets || []).slice(0, 3);
            for (const mt of toLike) {
              await favoriteTweet(mt.id, cfg.cookiesFile);
              await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
            }
            if (toLike.length) log(`[mutual] liked ${toLike.length} tweets from @${m.username}`);
          } catch {}
        }
      }
    }
  }

  log(`[mode-D] Starting search | queries: ${queries.length} | onlyEngaged: ${onlyEngaged} | onlyVerified: ${onlyVerified} | autoLike: ${autoLike} | autoFollow: ${autoFollow} | minLikes: ${minLikes} | minReplies: ${minReplies} | minFollowers: ${minFollowers}`);

  cleanupOldViralTweets();
  const viralBefore = getViralTweets();
  const viralIds = new Set(viralBefore.map(v => v.tweet_id));
  if (viralIds.size) log(`[viral] ${viralIds.size} hot tweets detected`);

  const viralQueries = Array.from(viralIds);
  const qStart = queries.length;
  if (viralQueries.length) {
    queries.unshift(...viralQueries);
    log(`[viral] ${viralQueries.length} tweet queries injected at front of queue`);
  }

  let total = 0;

  for (const q of queries) {
    if (total >= maxPerCycle) break;

    let result;
    try {
      result = await searchTimeline(q, cfg.cookiesFile, null, 'Latest');
    } catch (e) {
      log(`[mode-D] search error "${q}": ${e.message}`);
      continue;
    }

    const tweets = result?.tweets || [];
    log(`[mode-D] query "${q}" → found ${tweets.length} tweets`);

    if (trendSurfingEnabled && tweets.length > 0) {
      const cryptoSigs = ['crypto', 'blockchain', 'token', 'defi', 'nft', 'sol', 'eth', 'btc', 'coin', 'chain', 'web3', 'bitcoin', 'ethereum', 'solana', 'dex', 'airdrop', 'staking', 'meme', 'layer2', 'l2', 'mainnet', 'testnet', 'wallet', 'swap', 'bridge', 'dao', 'yield', 'farming', 'base', 'basechain', 'coinbase', 'based'];
      for (const t of tweets.slice(0, 10)) {
        const lowerText = (t.text || '').toLowerCase();
        if (!cryptoSigs.some(sig => lowerText.includes(sig))) continue;
        const words = lowerText.replace(/[#@,.:;!?]/g, '').split(/\s+/).filter(w => w.length > 3 && !blacklistWords.includes(w));
        const unique = [...new Set(words)].slice(0, 5);
        unique.forEach(w => bumpTrendWord(w));
      }
    }

    const highFollower = [];
    const regular = [];
    const threadHijack = [];
    let isThreadHijackSeen = false;

    for (const t of tweets) {
      if (!t?.id || !t?.text || !t?.author) continue;
      if (t.isRetweet) continue;
      if (Date.now() - new Date(t.createdAt).getTime() > MAX_AGE_MS) continue;
      if (getCommentCount(t.id) >= 1) continue;
      const isTopFunnel = !!t.inReplyToTweetId;
      const isThreadHijack = threadHijackMinReplies > 0 && isTopFunnel && (t.replyCount || 0) >= threadHijackMinReplies;
      if (!isTopFunnel && !isThreadHijack && (t.likeCount || 0) < minLikes) continue;
      if (!isTopFunnel && !isThreadHijack && (t.replyCount || 0) < minReplies) continue;
      if (!isTopFunnel && !isThreadHijack && minFollowers > 0 && (t.author_followers_count || 0) < minFollowers) continue;
      if (onlyVerified && !t.author_verified) continue;
      if (onlyEngaged && !isEngagedUser(t.author)) continue;
      if (minAccountAgeDays > 0 && t.author_created_at) {
        const created = new Date(t.author_created_at).getTime();
        if (Date.now() - created < minAccountAgeDays * 24 * 60 * 60 * 1000) continue;
      }
      if (blacklistWords.length) {
        const lower = (t.text || '').toLowerCase();
        if (blacklistWords.some(w => lower.includes(w.toLowerCase()))) continue;
      }
      if (q.length > 2 && !(t.text || '').toLowerCase().includes(q.toLowerCase())) continue;

      const followers = t.author_followers_count || 0;
      const isHighFollower = followers >= highFollowerMin;
      const isMutualBoost = smartConnectionsEnabled && t.author_user_id && mutualIds.has(t.author_user_id);

      if (isThreadHijack) {
        if (!isThreadHijackSeen) { isThreadHijackSeen = true; }
        threadHijack.push(t);
      } else if (isMutualBoost) {
        if (isHighFollower) highFollower.unshift(t);
        else regular.unshift(t);
      } else if (isHighFollower) {
        highFollower.push(t);
      } else {
        regular.push(t);
      }
    }

    const bucket = [...threadHijack, ...(prioritizeHighFollowers ? [...highFollower, ...regular] : [...regular, ...highFollower])];

    for (const t of bucket) {
      if (total >= maxPerCycle) break;

      const isViralCandidate = t.replyCount >= 50;
      const followers = t.author_followers_count || 0;
      const isHighFollower = followers >= highFollowerMin;
      const isHijack = threadHijack.includes(t);
      const isMutualReply = smartConnectionsEnabled && t.author_user_id && mutualIds.has(t.author_user_id);
      const isCompetitor = competitorReplyChance > 0 && (t.replyCount || 0) > 0 && Math.random() < competitorReplyChance;

      if (isHighFollower) {
        log(`[high-follower] ${t.id} | @${t.author} | followers:${followers} | likes:${t.likeCount||0} replies:${t.replyCount||0}`);
      }

      log(`[mode-D] PASS filter: ${t.id} | @${t.author} | likes:${t.likeCount||0} replies:${t.replyCount||0} followers:${followers}${t.author_verified ? ' ✓' : ''}${isHijack ? ' [THREAD]' : ''}${isMutualReply ? ' [MUTUAL]' : ''}${isCompetitor ? ' [COMPETITOR]' : ''}`);

      if (modeCfg.skipRepliedToday !== false && isUserRepliedToday(t.author)) {
        log(`[mode-D] SKIP @${t.author} — already replied today`);
        continue;
      }

      if (modeCfg.skipMutuals !== false && t.author_user_id && isMutual(t.author_user_id)) {
        log(`[mode-D] SKIP @${t.author} — already follows back (mutual)`);
        continue;
      }

      if (isViralCandidate) {
        seeViralTweet(t.id, t.replyCount || 0);
      }

      try {
        await Promise.race([
          waitForSlot(cfg, log),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('RATE_TIMEOUT — cycle will finish and auto-post')), 20 * 60_000)
          ),
        ]);

        if (autoLike) {
          try {
            await favoriteTweet(t.id, cfg.cookiesFile);
            trackStat('stat_likes');
            await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
          } catch (likeErr) {
            log(`[mode-D] like failed ${t.id}: ${likeErr.message}`);
          }
        }

        const persona = selectPersona(t.text, personas);
        const engagementStyle = pickEngagementStyle();
        const styleHint = STYLE_HINTS[engagementStyle] || '';
        const alreadyFollowed = t.author_user_id && isFollowing(t.author_user_id);
        const noFollowHint = alreadyFollowed ? ' DO NOT ask to follow back — you already follow this person.' : '';
        const combinedStyle = [modeCfg.style || cfg.ai?.style || '', persona, styleHint, noFollowHint].filter(Boolean).join('. ');
        if (alreadyFollowed) log(`[mode-D] @${t.author} already followed — no follow-back prompt`);
        const comment = await generateComment({
          tweetText: t.text,
          lang: 'auto',
          style: combinedStyle,
          ai: cfg.ai,
          author: t.author
        });

        if (!comment || comment.length < 3) {
          log(`[mode-D] AI returned empty/short comment — skipping`);
          continue;
        }

        const replyResult = await postTweet(comment, cfg.cookiesFile, { replyToId: t.id });
        markCommented(t.id, t.author || '');
        if (replyResult && replyResult !== 'ok') trackMyReply(replyResult, t.id);
        trackStat('stat_replies');
        markUserRepliedToday(t.author);

        if (autoFollow && t.author_user_id) {
          try {
            await followUser(t.author_user_id, cfg.cookiesFile);
            trackFollow(t.author_user_id, t.author);
            trackStat('stat_follows');
            log(`[mode-D] followed @${t.author} (rest_id: ${t.author_user_id})`);
          } catch (followErr) {
            log(`[mode-D] follow failed @${t.author}: ${followErr.message}`);
          }
        }

        total++;

        const highFollowerTag = isHighFollower ? ' [HIGH-FOLLOWER]' : '';
        const viralTag = isViralCandidate ? ' [VIRAL]' : '';
        const hijackTag = isHijack ? ' [THREAD-HIJACK]' : '';
        const mutualTag = isMutualReply ? ' [MUTUAL]' : '';
        const competitorTag = isCompetitor ? ' [COMPETITOR]' : '';
        const detectedLang = detectLanguage(t.text);
        log(`[mode-D] replied${highFollowerTag}${viralTag}${hijackTag}${mutualTag}${competitorTag} ${t.id} | lang: ${detectedLang} | q: ${q} | user: @${t.author}${autoFollow ? ' | followed: yes' : ''}${persona ? ' | persona: ' + persona.slice(0, 30) : ''} | "${comment.slice(0, 80)}"`);

        if (cfg.telegram?.botToken) {
          await sendAlert(cfg.telegram.botToken, cfg.telegram.chatId,
            `Mode D: Replied\nQuery: ${q}\nUser: @${t.author}`);
        }

        if (backfillLikeCount > 0) {
          try {
            const fromQuery = `from:@${t.author}`;
            const userTweets = await searchTimeline(fromQuery, cfg.cookiesFile, null, 'Latest');
            const entries = (userTweets?.tweets || []).filter(ut => ut.id !== t.id).slice(0, backfillLikeCount);
            for (const ut of entries) {
              await favoriteTweet(ut.id, cfg.cookiesFile);
              await new Promise(r => setTimeout(r, 800 + Math.random() * 600));
            }
            if (entries.length) log(`[backfill] liked ${entries.length} tweets from @${t.author}`);
          } catch (bfErr) {
            log(`[backfill] failed @${t.author}: ${bfErr.message}`);
          }
        }

        await new Promise(r => setTimeout(r, getSmartDelay()));
      } catch (e) {
        log(`[mode-D] reply error ${t.id}: ${e.message}`);
      }
    }
  }

  log(`[mode-D] Cycle finished. Replies: ${total}`);

  sendDailyReportIfTime(cfg, log).catch(() => {});

  try {
    const viralStats = getViralStats();
    if (viralStats?.total) {
      log(`[viral] cycle summary: ${viralStats.total} hot tweets | total growth: ${viralStats.total_growth}`);
    } else {
      log(`[viral] 0 hot tweets this cycle`);
    }
  } catch {}

  if (autoUnfollowDays > 0) {
    try {
      const stale = getStaleFollows(autoUnfollowDays);
      if (stale.length) {
        let unfollowed = 0, skipped = 0;
        for (const f of stale) {
          if (unfollowed >= 3) break;
          if (isMutual(f.user_id)) { skipped++; continue; }
          try {
            await unfollowUser(f.user_id, cfg.cookiesFile);
            removeFollowRecord(f.user_id);
            unfollowed++;
            log(`[unfollow] unfollowed @${f.username} (not mutual)`);
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
          } catch (ufErr) {
            log(`[unfollow] failed @${f.username}: ${ufErr.message}`);
          }
        }
        if (unfollowed || skipped) log(`[unfollow] unfollowed ${unfollowed}, kept ${skipped} mutuals`);
      }
    } catch {}
  }

  if (enableAutoPost) {
    try {
      const intervalMs = (modeCfg.autoPostIntervalMinutes || 240) * 60 * 1000;
      const maxPosts = modeCfg.autoPostsPerDay || 4;
      const lastTs = parseInt(getMeta('last_auto_post_ts') || '0');
      const postCount = parseInt(getMeta('auto_post_count') || '0');
      const dayReset = parseInt(getMeta('auto_post_day') || '0');
      const today = new Date().toDateString();
      const newDay = today !== new Date(dayReset).toDateString();
      if (newDay) { setMeta('auto_post_count', '0'); setMeta('auto_post_day', today); }
      const currentCount = newDay ? 0 : postCount;
      if (currentCount < maxPosts && Date.now() - lastTs >= intervalMs) {
        const lang = currentCount < 2 ? 'en' : 'vi';
        const langRule = lang === 'vi' ? 'VIET TIENG VIET.' : 'Write in ENGLISH.';
        const toneRule = lang === 'vi' ? 'giong chuyen gia crypto VN, tu nhien, gan gui' : 'expert crypto analyst, sharp but natural';
        let tokenData = null;
        let tokenSource = 'Bankr.bot';
        try {
          const freshTokens = await scrapeTokens({ minMC: 100_000, maxMC: 7_000_000, minVolRatio: 0.03 });
          if (freshTokens && freshTokens.length) {
            const withMC = freshTokens.filter(t => t.mcVal > 0);
            const pick = withMC.length ? withMC : freshTokens;
            tokenData = pick[Math.floor(Math.random() * pick.length)];
            tokenSource = tokenData.source === 'geckoterminal' ? 'GeckoTerminal' : tokenData.source === 'bankr' ? 'Bankr.bot' : tokenData.source === 'clanker' ? 'Clanker.world' : tokenData.source || 'DEX';
            try { writeFileSync('data/bankr-tokens.json', JSON.stringify(pick.slice(0, 25).map(t => ({ ticker: t.ticker, name: t.name, mc: t.mc, vol: t.vol })))); } catch {}
          }
        } catch {}
        if (!tokenData) {
          try {
            const tokens = JSON.parse(readFileSync('data/bankr-tokens.json', 'utf8'));
            const parseMC = (s) => { const n = parseFloat(s.replace(/[$,]/g,'')); return s.includes('K') ? n*1e3 : s.includes('M') ? n*1e6 : s.includes('B') ? n*1e9 : n; };
            const inRange = tokens.filter(t => { const v = parseMC(t.mc); return v >= 100_000 && v <= 7_000_000; });
            if (inRange.length) tokenData = inRange[Math.floor(Math.random() * inRange.length)];
            else if (tokens.length) tokenData = tokens[Math.floor(Math.random() * tokens.length)];
          } catch {}
        }
        const topic = tokenData
          ? `${tokenData.ticker} (${tokenData.name}) | MC: ${tokenData.mc} | 24h Vol: ${tokenData.vol} | on ${tokenSource} (Base)`
          : (modeCfg.autoPostTopics || ['crypto alpha'])[Math.floor(Math.random() * (modeCfg.autoPostTopics || ['crypto alpha']).length)];

        const threadSpecs = [
          { n: 1, label: 'hook', prompt: `${langRule} ${toneRule}. Tweet 1: catchy hook about ${topic}. Mention ticker + MC. Why this token matters right now. Under 280 chars. No hashtags.` },
          { n: 2, label: 'analysis', prompt: `${langRule} ${toneRule}. Tweet 2: analyze ${topic}. Based on MC and 24h vol, what does this mean? Is volume healthy vs MC? What's the sentiment? Compare to similar Base tokens. Under 280 chars.` },
          { n: 3, label: 'verdict', prompt: `${langRule} ${toneRule}. Tweet 3: verdict on ${topic} — bullish/bearish/neutral. What's the play (buy/hold/skip)? What would make you bullish? Under 280 chars.` },
        ];

        const tweets = [];
        for (const spec of threadSpecs) {
          try {
            const text = await generateComment({ tweetText: spec.prompt, lang: 'auto', style: modeCfg.style || cfg.ai?.style || '', ai: cfg.ai });
            if (text && text.length > 10) {
              const clean = text.replace(/^["'`]+|["'`]+$/g, '').trim();
              tweets.push(clean);
            }
          } catch (e) { log(`[auto-post] gen tweet ${spec.n} failed: ${e.message}`); }
        }
        if (tweets.length < 3) { log(`[auto-post] too few tweets generated (${tweets.length}), skipping`); return; }

        let mediaIds = [];
        if (tokenData) {
          try {
            const parseNum = (s) => { const n = parseFloat(s.replace(/[$,]/g,'')); return s.includes('K') ? n*1e3 : s.includes('M') ? n*1e6 : s.includes('B') ? n*1e9 : n; };
            const mcVal = parseNum(tokenData.mc);
            const volVal = parseNum(tokenData.vol);
            const hours = Array.from({length: 24}, (_, i) => `${23-i}h`);

            let realPrice = null, realChange24 = 0;
            if (tokenData.address) {
              try {
                const dexData = await retry(() => new Promise((resolve, reject) => {
                  https.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenData.address}`, (res) => {
                    let raw = ''; res.on('data', c => raw += c);
                    res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
                  }).on('error', reject);
                }), 2, 1500);
                const bestPair = (dexData?.pairs || []).sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0))[0];
                if (bestPair) {
                  realPrice = parseFloat(bestPair.priceUsd) || null;
                  realChange24 = parseFloat(bestPair.priceChange?.h24) || 0;
                }
              } catch {}
            }

            const priceBase = realPrice ? realPrice / (1 + realChange24/100) : Math.max(mcVal / 1e9 * 0.01, 0.00001);
            const priceEnd = realPrice || priceBase * (1 + (Math.random() - 0.45) * 0.3);
            const isUp = priceEnd >= priceBase;
            const priceData = [];
            for (let i = 0; i < 24; i++) {
              const t = i / 23;
              const base = priceBase + (priceEnd - priceBase) * t;
              const noise = (Math.random() - 0.48) * priceBase * 0.06;
              priceData.push(Math.max(base + noise, priceBase * 0.6));
            }
            const lineColor = isUp ? '#00ffcc' : '#ff4466';
            const glowColor = isUp ? 'rgba(0,255,204,0.08)' : 'rgba(255,68,102,0.08)';
            const fillColor = isUp ? 'rgba(0,255,204,0.12)' : 'rgba(255,68,102,0.12)';
            const volData = Array.from({length: 24}, () => volVal > 0 ? volVal * (0.01 + Math.random() * 0.08) : mcVal * 0.001 * (0.01 + Math.random() * 0.08));
            const ticker = tokenData.ticker || '$TOKEN';

            const chartCfg = {
              type: 'bar',
              data: {
                labels: hours,
                datasets: [
                  { type: 'line', label: 'Price', data: priceData, borderColor: lineColor, backgroundColor: fillColor, fill: true, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: lineColor, pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2, tension: 0.35, yAxisID: 'y', order: 1 },
                  { type: 'line', label: 'Glow', data: priceData, borderColor: glowColor, backgroundColor: 'transparent', fill: false, borderWidth: 8, pointRadius: 0, tension: 0.35, yAxisID: 'y', order: 0 },
                  { type: 'bar', label: 'Volume', data: volData, backgroundColor: isUp ? 'rgba(0,255,204,0.12)' : 'rgba(255,68,102,0.10)', borderColor: isUp ? 'rgba(0,255,204,0.25)' : 'rgba(255,68,102,0.20)', borderWidth: 1, borderRadius: 2, yAxisID: 'y1', order: 2 }
                ]
              },
              options: {
                responsive: false,
                plugins: {
                  legend: { display: false },
                  title: { display: false },
                  tooltip: { mode: 'index', intersect: false, backgroundColor: 'rgba(10,10,30,0.95)', titleColor: '#aaa', bodyColor: '#fff', borderColor: lineColor, borderWidth: 1, cornerRadius: 6 }
                },
                scales: {
                  x: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#555', font: { size: 10, weight: 'bold' }, maxTicksLimit: 6, callback: 'function(v,i){return i%6===0?this.getLabelForValue(v):\"\"}' } },
                  y: { position: 'right', grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#999', font: { size: 10 }, callback: 'function(v){return\"$\"+v.toFixed(v<0.001?7:v<0.01?5:3)}' } },
                  y1: { position: 'left', grid: { display: false }, ticks: { color: 'rgba(255,255,255,0.2)', font: { size: 9 }, callback: 'function(v){return v>=1e6?\"$\"+(v/1e6).toFixed(1)+\"M\":v>=1e3?\"$\"+(v/1e3).toFixed(1)+\"K\":\"$\"+v.toFixed(0)}' } }
                }
              },
              layout: { padding: { top: 50, right: 80, bottom: 15, left: 15 } }
            };

            const revETH = tokenData.revenue ? parseFloat(tokenData.revenue) : null;
            const revStr = revETH ? ` | ${revETH.toFixed(1)} WETH/wk` : '';

            const pctChange = Math.abs((priceEnd - priceBase) / priceBase * 100).toFixed(1);
            const realTag = realPrice ? ' ◆ DEX' : '';
            const badgeColor = isUp ? '#00ffcc' : '#ff4466';
            const overlays = [{
              type: 'textBlock',
              x: 14, y: 10,
              text: `${ticker}  ${tokenData.name}\nMC: ${tokenData.mc}  |  24h Vol: ${tokenData.vol}${revStr}\n${isUp ? '▲' : '▼'} ${pctChange}% 24h${realTag}`,
              color: '#fff',
              fontFamily: 'monospace',
              fontSize: 14,
              lineHeight: 1.5
            }, {
              type: 'rectangle',
              x: 650, y: 10,
              width: 85, height: 30,
              color: badgeColor,
              opacity: 0.15,
              borderRadius: 6
            }, {
              type: 'textBlock',
              x: 658, y: 14,
              text: `${isUp ? '▲' : '▼'} ${pctChange}%`,
              color: badgeColor,
              fontFamily: 'monospace',
              fontSize: 15,
              bold: true
            }];

            const chartUrl = `https://quickchart.io/chart?w=900&h=500&b=%2313131d&f=png&devicePixelRatio=2&c=${encodeURIComponent(JSON.stringify(chartCfg))}&encoding=url&post=1&overlay=${encodeURIComponent(JSON.stringify(overlays))}`;
            const https = await import('https');
            const imgBuf = await retry(() => new Promise((resolve, reject) => {
              https.get(chartUrl, (res) => {
                if (res.statusCode !== 200) { reject(new Error(`chart HTTP ${res.statusCode}`)); return; }
                const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
              }).on('error', reject);
            }), 2, 2000);
            if (!imgBuf || imgBuf.length < 1000) throw new Error('chart too small');
            const upload = await uploadMedia(imgBuf, cfg.cookiesFile);
            if (upload?.media_id_string) mediaIds = [upload.media_id_string];

            if (tokenData.img) {
              try {
                const logoBuf = await new Promise((resolve, reject) => {
                  https.get(tokenData.img, (res) => {
                    if (res.statusCode !== 200) { reject(new Error(`logo HTTP ${res.statusCode}`)); return; }
                    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
                  }).on('error', reject);
                });
                if (logoBuf && logoBuf.length > 500) {
                  const logoUpload = await uploadMedia(logoBuf, cfg.cookiesFile);
                  if (logoUpload?.media_id_string) mediaIds.push(logoUpload.media_id_string);
                }
              } catch (e) { log(`[auto-post] logo failed: ${e.message}`); }
            }
          } catch (imgErr) { log(`[auto-post] image failed: ${imgErr.message}`); }
        }

        let lastId = null, posted = 0;
        for (let i = 0; i < tweets.length; i++) {
          await waitForSlot(cfg, log);
          const opts = {};
          if (i === 0 && mediaIds.length) opts.mediaIds = mediaIds;
          if (i > 0 && lastId) opts.replyToId = lastId;
          const result = await postTweet(tweets[i], cfg.cookiesFile, opts);
          if (result && typeof result === 'string' && result !== 'ok') lastId = result;
          posted++;
          if (i < tweets.length - 1) await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
        }

        const wordCount = tweets.reduce((c, p) => c + p.split(/\s+/).length, 0);
        setMeta('last_auto_post_ts', String(Date.now()));
        setMeta('auto_post_count', String(currentCount + 1));
        log(`[auto-post] #${currentCount + 1}/${maxPosts} | lang: ${lang} | token: ${tokenData?.ticker || 'N/A'} | thread: ${posted} tweets | ~${wordCount} words${mediaIds.length ? ' | media: ' + mediaIds.length : ''}`);
        trackStat('stat_autoposts');

        if (cfg.telegram?.botToken) {
          try {
            await sendAlert(cfg.telegram.botToken, cfg.telegram.chatId,
              `📊 Auto-post #${currentCount + 1}/${maxPosts}\nToken: ${tokenData?.ticker || 'N/A'} ${tokenData?.name || ''}\nMC: ${tokenData?.mc || 'N/A'} | Vol: ${tokenData?.vol || 'N/A'}\nLang: ${lang} | ${posted} tweets${mediaIds.length ? ' + ' + mediaIds.length + ' media' : ''}`);
          } catch {}
        }

        if (lastId && tweets.length >= 3) {
          try {
            const delayMs = 180_000 + Math.random() * 120_000;
            log(`[auto-post] reply in ${Math.round(delayMs/1000)}s...`);
            await new Promise(r => setTimeout(r, delayMs));

            const replyPrompt = `${langRule} ${toneRule}. Reply to your own thread about ${topic}. Add one more insight: on-chain signal, whale alert, or community sentiment. Keep it sharp, under 240 chars. No hashtags.`;
            const replyText = await generateComment({ tweetText: replyPrompt, lang: 'auto', style: modeCfg.style || cfg.ai?.style || '', ai: cfg.ai });
            if (replyText && replyText.length > 10) {
              const clean = replyText.replace(/^[\"'`]+|[\"'`]+$/g, '').trim();
              await waitForSlot(cfg, log);
              await postTweet(clean, cfg.cookiesFile, { replyToId: lastId });
              log(`[auto-post] reply added: ${clean.slice(0, 60)}...`);
            }
          } catch (e) { log(`[auto-post] reply failed: ${e.message}`); }
        }
      }
    } catch (e) { log(`[auto-post] error: ${e.message}`); }
  }
}
