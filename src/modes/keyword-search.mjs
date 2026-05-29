import { searchTimeline, postTweet, favoriteTweet, followUser, unfollowUser, uploadMedia, fetchTweetEngagement, deleteTweet, getTweetReplies } from '../lib/twitter-http.mjs';
import { generateComment, selectPersona } from '../lib/ai-commenter.mjs';
import { detectLanguage } from '../lib/language.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { scrapeTokens } from '../lib/token-scraper.mjs';
import { pickBestToken } from '../lib/token-scorer.mjs';
import { buildInfographicChart, downloadLogo } from '../lib/chart-builder.mjs';
import { generateReplyImage } from '../lib/image-reply.mjs';
import { getCommentCount, markCommented, isEngagedUser, markUserEngaged,
         seeViralTweet, getViralTweets, cleanupOldViralTweets, getViralStats,
         trackFollow, getStaleFollows, removeFollowRecord,
         isMutual, markMutual, getMutuals, getMutualCount,
         isFollowing,
         getTrendKeywords, bumpTrendWord, cleanupTrendWords,
         getMeta, setMeta, trackMyReply, isReplyToMyComment,
         trackReplyFeedback, updateReplyFeedback, getUncheckedFeedback,
         getBestStyles, getBestPersonas, cleanupOldFeedback,
         trackAutoPost, updateAutoPostEngagement, getUncheckedAutoPosts, getAutoPostStats,
         isFollower, markFollower } from '../lib/store.mjs';
import { getFriendship } from '../lib/twitter-http.mjs';
import { waitForSlot } from '../lib/rate-limiter.mjs';
import { sendAlert } from '../lib/telegram.mjs';

const sessionCommentedIds = new Set();
const sessionRepliedUsers = new Set();

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

function weightedPick(items, scoreKey = 'score') {
  if (!items || !items.length) return null;
  const total = items.reduce((s, i) => s + Math.max(i[scoreKey] || 0.1, 0.1), 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= Math.max(item[scoreKey] || 0.1, 0.1);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function pickEngagementStyleWeighted(modeCfg) {
  if (modeCfg.feedbackLoopEnabled === false) return pickEngagementStyle();
  const best = getBestStyles(3);
  if (best && best.length >= 2) {
    const chosen = weightedPick(best);
    if (chosen) {
      const style = chosen.engagement_style;
      if (ENGAGEMENT_STYLES.includes(style)) return style;
    }
  }
  return pickEngagementStyle();
}

function pickPersonaWeighted(tweetText, availablePersonas, modeCfg) {
  if (modeCfg.feedbackLoopEnabled === false) return selectPersona(tweetText, availablePersonas);
  const best = getBestPersonas(3);
  if (best && best.length >= 2) {
    const chosen = weightedPick(best);
    if (chosen && availablePersonas.includes(chosen.persona)) return chosen.persona;
  }
  return selectPersona(tweetText, availablePersonas);
}

async function checkReplyFeedback(cfg, log) {
  const unchecked = getUncheckedFeedback(3600000, 5);
  if (!unchecked.length) return;
  log(`[feedback] checking ${unchecked.length} replies...`);
  let updated = 0;
  for (const fb of unchecked) {
    try {
      const eng = await fetchTweetEngagement(fb.tweet_id, cfg.cookiesFile);
      if (eng) {
        updateReplyFeedback(fb.tweet_id, eng.likes, eng.replies);
        updated++;
        if (eng.likes > 0 || eng.replies > 0) {
          log(`[feedback] ${fb.tweet_id} | ❤️${eng.likes} 💬${eng.replies} | style:${fb.engagement_style}`);
        }
      } else {
        updateReplyFeedback(fb.tweet_id, 0, 0);
      }
    } catch (e) {
      updateReplyFeedback(fb.tweet_id, 0, 0);
    }
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
  }
  if (updated) {
    cleanupOldFeedback();
    const bestStyles = getBestStyles(2);
    if (bestStyles.length) {
      log(`[feedback] top styles: ${bestStyles.map(s => `${s.engagement_style}(${s.score.toFixed(1)})`).join(', ')}`);
    }
  }
}

const PEAK_SLOTS_VN = [
  { start: 7, end: 10, label: 'morning rush' },
  { start: 11, end: 17, label: 'lunch break' },
  { start: 19, end: 22, label: 'evening prime' },
];

function isInPeakSlot() {
  const h = getVietnamHour();
  return PEAK_SLOTS_VN.find(s => h >= s.start && h < s.end) || null;
}

async function checkAutoPostFeedback(cfg, log) {
  const unchecked = getUncheckedAutoPosts(7200000, 5);
  if (!unchecked.length) return;
  log(`[auto-post-fb] checking ${unchecked.length} posts...`);
  let updated = 0;
  for (const ap of unchecked) {
    try {
      const eng = await fetchTweetEngagement(ap.tweet_id, cfg.cookiesFile);
      if (eng) {
        updateAutoPostEngagement(ap.tweet_id, eng.likes, eng.replies, 0, 0);
        updated++;
        if (eng.likes > 0 || eng.replies > 0) {
          log(`[auto-post-fb] ${ap.token_ticker} | ❤️${eng.likes} 💬${eng.replies}`);
        }
      } else {
        updateAutoPostEngagement(ap.tweet_id, 0, 0, 0, 0);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 800 + Math.random() * 700));
  }
  if (updated) {
    const stats = getAutoPostStats();
    if (stats && stats.total > 0) {
      log(`[auto-post-fb] avg ❤️${stats.avg_likes.toFixed(1)} avg 💬${stats.avg_replies.toFixed(1)} (${stats.total} posts)`);
    }
  }
}

function trackStat(key) {
  const today = new Date().toDateString();
  const day = getMeta('stat_day');
  if (day !== today) {
    setMeta('stat_day', today);
    setMeta('stat_replies', '0');
    setMeta('stat_likes', '0');
    setMeta('stat_follows', '0');
    setMeta('stat_autoposts', '0');
    setMeta('stat_quotes', '0');
    setMeta('stat_images', '0');
  }
  const current = parseInt(getMeta(key) || '0');
  setMeta(key, String(current + 1));
}

async function autoDeleteDuds(cfg, log) {
  const unchecked = getUncheckedAutoPosts(6 * 3600000, 10);
  if (!unchecked.length) return;
  let deleted = 0;
  for (const ap of unchecked) {
    try {
      const eng = await fetchTweetEngagement(ap.tweet_id, cfg.cookiesFile);
      if (eng) {
        updateAutoPostEngagement(ap.tweet_id, eng.likes, eng.replies, 0, 0);
        if (eng.likes === 0 && eng.replies === 0) {
          try {
            await deleteTweet(ap.tweet_id, cfg.cookiesFile);
            deleted++;
            log(`[auto-delete] removed dud: ${ap.token_ticker} ${ap.tweet_id}`);
          } catch (delErr) {
            log(`[auto-delete] delete failed ${ap.tweet_id}: ${delErr.message}`);
          }
        }
      } else {
        updateAutoPostEngagement(ap.tweet_id, 0, 0, 0, 0);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
  }
  if (deleted) log(`[auto-delete] removed ${deleted} dud posts`);
}

async function sendEnhancedDailyReport(cfg, log) {
  const now = new Date();
  const hour = now.getHours();
  const today = now.toDateString();
  const sent = getMeta('report_sent_day');
  if (sent === today || hour < 22) return;
  if (hour < 22 || !cfg.telegram?.botToken) return;

  const replies = parseInt(getMeta('stat_replies') || '0');
  const likes = parseInt(getMeta('stat_likes') || '0');
  const follows = parseInt(getMeta('stat_follows') || '0');
  const autoposts = parseInt(getMeta('stat_autoposts') || '0');
  const quotes = parseInt(getMeta('stat_quotes') || '0');
  const images = parseInt(getMeta('stat_images') || '0');
  const total = replies + likes + follows + autoposts + quotes;
  if (total === 0) return;

  try {
    const bestStyles = getBestStyles(2);
    const bestPersonas = getBestPersonas(2);
    const apStats = getAutoPostStats();
    const apTokens = getBestAutoPostTokens(2);
    const mutualCount = getMutualCount();

    let msg = `📊 *Daily Report ${today}*\n\n`;
    msg += `*Activity*\n`;
    msg += `💬 Replies: ${replies}\n`;
    msg += `❤️ Likes: ${likes}\n`;
    msg += `👥 Follows: ${follows}\n`;
    msg += `📝 Auto-posts: ${autoposts}\n`;
    msg += `🔁 Quote tweets: ${quotes}\n`;
    msg += `🖼 Image replies: ${images}\n`;
    msg += `🤝 Mutuals: ${mutualCount}\n`;
    msg += `━━━━━━━━━━━━━\n`;
    msg += `🔥 Total actions: ${total}\n\n`;

    if (bestStyles.length) {
      msg += `*Top Styles*\n`;
      bestStyles.forEach(s => msg += `• ${s.engagement_style}: score ${s.score.toFixed(1)} (${s.n} replies)\n`);
      msg += `\n`;
    }

    if (bestPersonas.length) {
      msg += `*Top Personas*\n`;
      bestPersonas.forEach(p => msg += `• ${p.persona.slice(0, 40)}: score ${p.score.toFixed(1)}\n`);
      msg += `\n`;
    }

    if (apStats && apStats.total > 0) {
      msg += `*Auto-Post Stats*\n`;
      msg += `• ${apStats.total} posts tracked\n`;
      msg += `• Avg ❤️ ${apStats.avg_likes.toFixed(1)} | 💬 ${apStats.avg_replies.toFixed(1)}\n`;
      if (apTokens.length) {
        apTokens.forEach(t => msg += `• ${t.token_ticker}: score ${t.score.toFixed(1)}\n`);
      }
    }

    await sendAlert(cfg.telegram.botToken, cfg.telegram.chatId, msg);
    setMeta('report_sent_day', today);
    log('[report] enhanced daily report sent');
  } catch (e) { log(`[report] failed: ${e.message}`); }
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
  if (typeof log !== 'function') log = (msg) => process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
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
  const quoteTweetChance = modeCfg.quoteTweetChance || 0;
  const imageReplyChance = modeCfg.imageReplyChance || 0;
  const imageReplyTypes = modeCfg.imageReplyTypes || ['chart'];
  const targetUsers = modeCfg.targetUsers || [];
  const blockedUsers = modeCfg.blockedUsers || [];

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

  const cycleNum = parseInt(getMeta('cycle_count') || '0');
  if (cycleNum > 0 && cycleNum % 3 === 0 && modeCfg.feedbackLoopEnabled !== false) {
    try { await checkReplyFeedback(cfg, log); } catch {}
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

  if (targetUsers.length) {
    const userQueries = targetUsers.map(u => `from:@${u}`);
    queries.unshift(...userQueries);
    log(`[target] watching ${targetUsers.length} users: ${targetUsers.join(', ')}`);
  }

  let total = 0;
  const repliedThisCycle = new Set();

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
      const cryptoSigs = ['crypto', 'blockchain', 'token', 'defi', 'nft', 'sol', 'eth', 'btc', 'coin', 'chain', 'web3', 'bitcoin', 'ethereum', 'solana', 'dex', 'airdrop', 'staking', 'meme', 'layer2', 'l2', 'mainnet', 'testnet', 'wallet', 'swap', 'bridge', 'dao', 'yield', 'farming', 'base', 'basechain', 'coinbase', 'based', 'tăng', 'giảm', 'pump', 'dump', 'hold', 'chốt', 'lời', 'lỗ', 'sàn', 'ví', 'giao dịch', 'trend', 'vốn', 'rủi', 'ro', 'phân', 'tích', 'kèo', 'thơm', 'whale', 'cá', 'mập'];
      const STOPWORDS = new Set(['không', 'cũng', 'nhưng', 'vậy', 'này', 'đó', 'kia', 'nào', 'sao', 'đang', 'đã', 'sẽ', 'vào', 'cho', 'với', 'qua', 'của', 'là', 'có', 'một', 'được', 'mình', 'bạn', 'anh', 'em', 'tôi', 'nó', 'nhiều', 'rất', 'thì', 'nên', 'mà', 'đây', 'nhé', 'nha', 'rồi', 'nữa', 'hơn', 'thôi', 'nếu', 'khi', 'để', 'từ', 'còn', 'và', 'hay', 'vì', 'những', 'các', 'đi', 'ra', 'lên', 'bị', 'chỉ', 'thế', 'làm', 'cái', 'người', 'trong', 'về']);
      for (const t of tweets.slice(0, 10)) {
        const lowerText = (t.text || '').toLowerCase();
        if (!cryptoSigs.some(sig => lowerText.includes(sig))) continue;
        const words = lowerText.replace(/[#@,.:;!?]/g, '').split(/\s+/).filter(w => w.length > 3 && !blacklistWords.includes(w) && cryptoSigs.some(s => s.length > 2 && w.includes(s)));
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
      if (sessionCommentedIds.has(t.id)) {
        log(`[mode-D] SKIP tweet ${t.id} — already commented this session`);
        continue;
      }
      const isTopFunnel = !!t.inReplyToStatusId;
      const isThreadHijack = threadHijackMinReplies > 0 && isTopFunnel && (t.replyCount || 0) >= threadHijackMinReplies;
      const isTargetQuery = q.startsWith('from:@');
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
      if (!isTargetQuery && q.length > 2 && !(t.text || '').toLowerCase().includes(q.toLowerCase())) continue;

      const followers = t.author_followers_count || 0;
      const isHighFollower = followers >= highFollowerMin;
      const isMutualBoost = smartConnectionsEnabled && t.author_user_id && mutualIds.has(t.author_user_id);

      if (isThreadHijack) {
        if (!isThreadHijackSeen) { isThreadHijackSeen = true; }
        t._isTarget = isTargetQuery;
        threadHijack.push(t);
      } else if (isMutualBoost) {
        t._isTarget = isTargetQuery;
        if (isHighFollower) highFollower.unshift(t);
        else regular.unshift(t);
      } else if (isHighFollower) {
        t._isTarget = isTargetQuery;
        highFollower.push(t);
      } else {
        t._isTarget = isTargetQuery;
        regular.push(t);
      }
    }

    const bucket = [...threadHijack, ...(prioritizeHighFollowers ? [...highFollower, ...regular] : [...regular, ...highFollower])];

    for (const t of bucket) {
      if (total >= maxPerCycle) break;

      if (repliedThisCycle.has(t.author)) {
        log(`[mode-D] SKIP @${t.author} — already replied this cycle`);
        continue;
      }

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

      if (blockedUsers.length && blockedUsers.includes(t.author)) {
        log(`[mode-D] SKIP @${t.author} — blocked user`);
        continue;
      }

      if (modeCfg.skipFollowing !== false && t.author_user_id && isFollowing(t.author_user_id)) {
        log(`[mode-D] SKIP @${t.author} — already following`);
        continue;
      }

      let followerCheck = false;
      if (modeCfg.skipFollowers === true && t.author) {
        if (t.author_user_id && isFollower(t.author_user_id)) {
          followerCheck = true;
          log(`[mode-D] SKIP @${t.author} — already follows you (cached)`);
          continue;
        }
        try {
          const fs = await getFriendship(t.author, cfg.cookiesFile);
          if (fs?.relationship?.source?.followed_by) {
            followerCheck = true;
            if (t.author_user_id) markFollower(t.author_user_id, t.author);
            log(`[mode-D] SKIP @${t.author} — already follows you`);
            continue;
          }
        } catch {}
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

        const persona = pickPersonaWeighted(t.text, personas, modeCfg);
        const engagementStyle = pickEngagementStyleWeighted(modeCfg);
        const styleHint = STYLE_HINTS[engagementStyle] || '';
        const alreadyFollowed = t.author_user_id && isFollowing(t.author_user_id);
        const noFollowHint = alreadyFollowed ? ' DO NOT ask to follow back — you already follow this person.' : '';
        const isQuoteTweet = quoteTweetChance > 0 && Math.random() < quoteTweetChance;

        let combinedStyle = [modeCfg.style || cfg.ai?.style || '', persona, styleHint, noFollowHint].filter(Boolean).join('. ');
        if (isQuoteTweet) {
          combinedStyle += '. This is a QUOTE TWEET — be bold, share your own spicy take. Add real value that makes people want to engage.';
        }

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

        let mediaIds = [];
        if (imageReplyChance > 0 && Math.random() < imageReplyChance && !isQuoteTweet) {
          try {
            const imgType = imageReplyTypes[Math.floor(Math.random() * imageReplyTypes.length)] || 'chart';
            const imgBuf = await generateReplyImage(t.text, imgType);
            if (imgBuf && imgBuf.length > 500) {
              const upload = await uploadMedia(imgBuf, cfg.cookiesFile);
              if (upload?.media_id_string) {
                mediaIds = [upload.media_id_string];
                log(`[mode-D] attached ${imgType} image to reply`);
              }
            }
          } catch (imgErr) { log(`[mode-D] image gen failed: ${imgErr.message}`); }
        }

        const postOpts = {};
        if (isQuoteTweet) {
          postOpts.quoteTweetId = t.id;
        } else {
          postOpts.replyToId = t.id;
        }
        if (mediaIds.length) postOpts.mediaIds = mediaIds;

        const replyResult = await postTweet(comment, cfg.cookiesFile, postOpts);
        markCommented(t.id, t.author || '');
        if (replyResult && replyResult !== 'ok') {
          trackMyReply(replyResult, t.id);
          trackReplyFeedback(replyResult, engagementStyle, persona);
        }
        trackStat('stat_replies');
        if (isQuoteTweet) trackStat('stat_quotes');
        if (mediaIds.length) trackStat('stat_images');
        markUserRepliedToday(t.author);
        repliedThisCycle.add(t.author);
        sessionCommentedIds.add(t.id);

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
        const quoteTag = isQuoteTweet ? ' [QUOTE]' : '';
        const imageTag = mediaIds.length ? ' [IMG]' : '';
        const targetTag = t._isTarget ? ' [TARGET]' : '';
        const detectedLang = detectLanguage(t.text);
        log(`[mode-D] replied${highFollowerTag}${viralTag}${hijackTag}${mutualTag}${competitorTag}${quoteTag}${imageTag}${targetTag} ${t.id} | lang: ${detectedLang} | q: ${q} | user: @${t.author}${autoFollow ? ' | followed: yes' : ''}${persona ? ' | persona: ' + persona.slice(0, 30) : ''} | style: ${engagementStyle} | "${comment.slice(0, 80)}"`);

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

        if (!t.inReplyToStatusId && modeCfg.threadReplies !== false && total < maxPerCycle) {
          try {
            const replies = await getTweetReplies(t.id, cfg.cookiesFile, 10);
            const candidates = replies.filter(r =>
              r?.id && r?.author && r.author !== t.author &&
              !sessionCommentedIds.has(r.id) &&
              getCommentCount(r.id) < 1 &&
              !repliedThisCycle.has(r.author) &&
              !isUserRepliedToday(r.author)
            );
            const pick = candidates.slice(0, 3);
            for (const rt of pick) {
              if (total >= maxPerCycle) break;
              try {
                await waitForSlot(cfg, log);
                const rComment = await generateComment({
                  tweetText: rt.text, lang: 'auto',
                  style: (modeCfg.style || cfg.ai?.style || '') + '. Reply to someone in a thread.',
                  ai: cfg.ai, author: rt.author
                });
                if (rComment && rComment.length >= 3) {
                  const rResult = await postTweet(rComment, cfg.cookiesFile, { replyToId: rt.id });
                  markCommented(rt.id, rt.author || '');
                  if (rResult && rResult !== 'ok') trackMyReply(rResult, rt.id);
                  sessionCommentedIds.add(rt.id);
                  repliedThisCycle.add(rt.author);
                  markUserRepliedToday(rt.author);
                  trackStat('stat_replies');
                  total++;
                  log(`[mode-D] thread reply ${rt.id} | @${rt.author} | \"${rComment.slice(0, 50)}\"`);
                }
                if (autoLike) { try { await favoriteTweet(rt.id, cfg.cookiesFile); } catch {} }
                await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000));
              } catch (rErr) { log(`[mode-D] thread reply error: ${rErr.message}`); }
            }
            if (pick.length) log(`[mode-D] thread replies: ${pick.length} added to ${t.id}`);
          } catch (thErr) { log(`[mode-D] thread fetch error: ${thErr.message}`); }
        }

        await new Promise(r => setTimeout(r, getSmartDelay()));
      } catch (e) {
        log(`[mode-D] reply error ${t.id}: ${e.message}`);
      }
    }
  }

  log(`[mode-D] Cycle finished. Replies: ${total}`);

  try { await autoDeleteDuds(cfg, log); } catch {}
  sendEnhancedDailyReport(cfg, log).catch(() => {});

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
      const maxPosts = modeCfg.autoPostsPerDay || 4;
      const postCount = parseInt(getMeta('auto_post_count') || '0');
      const dayReset = parseInt(getMeta('auto_post_day') || '0');
      const today = new Date().toDateString();
      const newDay = today !== new Date(dayReset).toDateString();
      if (newDay) { setMeta('auto_post_count', '0'); setMeta('auto_post_day', today); }
      const currentCount = newDay ? 0 : postCount;

      const lastSlot = getMeta('last_auto_post_slot') || '';
      const peak = isInPeakSlot();
      const slotKey = peak ? `${peak.start}-${peak.end}` : 'offpeak';

      const hourSinceLast = parseInt(getMeta('last_auto_post_ts') || '0');
      const minGap = peak ? 90 * 60 * 1000 : 180 * 60 * 1000;

      if (currentCount < maxPosts && Date.now() - hourSinceLast >= minGap && peak && slotKey !== lastSlot) {
        setMeta('last_auto_post_slot', slotKey);

        checkAutoPostFeedback(cfg, log).catch(() => {});

        const lang = currentCount < 2 ? 'en' : 'vi';
        const langRule = lang === 'vi' ? 'VIET TIENG VIET.' : 'Write in ENGLISH.';
        const toneRule = lang === 'vi' ? 'giong chuyen gia crypto VN, tu nhien, gan gui' : 'expert crypto analyst, sharp but natural';
        let tokenData = null;
        let tokenSource = 'Bankr.bot';
        try {
          const freshTokens = await scrapeTokens({ minMC: 100_000, maxMC: 7_000_000, minVolRatio: 0.03 });
          if (freshTokens && freshTokens.length) {
            tokenData = await pickBestToken(freshTokens, log);
            if (tokenData) {
              tokenSource = tokenData.source === 'geckoterminal' ? 'GeckoTerminal' : tokenData.source === 'bankr' ? 'Bankr.bot' : tokenData.source === 'clanker' ? 'Clanker.world' : tokenData.source || 'DEX';
            }
            try { writeFileSync('data/bankr-tokens.json', JSON.stringify(freshTokens.slice(0, 25).map(t => ({ ticker: t.ticker, name: t.name, mc: t.mc, vol: t.vol })))); } catch {}
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
            const { buffer: chartBuf } = await buildInfographicChart(tokenData);
            if (chartBuf && chartBuf.length > 1000) {
              const upload = await uploadMedia(chartBuf, cfg.cookiesFile);
              if (upload?.media_id_string) mediaIds = [upload.media_id_string];
            }

            if (tokenData.img) {
              try {
                const logoBuf = await downloadLogo(tokenData.img);
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

        if (lastId && tokenData) {
          trackAutoPost(lastId, tokenData.ticker, tokenData.name, lang, tweets.length);
        }

        log(`[auto-post] #${currentCount + 1}/${maxPosts} | lang: ${lang} | token: ${tokenData?.ticker || 'N/A'} | thread: ${posted} tweets | ~${wordCount} words${mediaIds.length ? ' | media: ' + mediaIds.length : ''}${peak ? ' | slot: ' + peak.label : ''}`);
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
