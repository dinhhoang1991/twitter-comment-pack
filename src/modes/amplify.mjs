/**
 * Mode B — watch the user's own latest tweet, then post comments under
 * trending hashtag tweets that link back to that tweet.
 *
 * Pattern: pick latest non-reply non-retweet from owner; for each
 * configured hashtag, find recent matching tweets, reply with a short
 * cross-promo pointing to owner's tweet URL.
 */
import { searchUserTweets, searchTimeline, postTweet, fetchListTweets } from '../lib/twitter-http.mjs';
import { detectLanguage } from '../lib/language.mjs';
import { generateComment } from '../lib/ai-commenter.mjs';
import { alreadyCommented, markCommented, getMeta, setMeta } from '../lib/store.mjs';
import { waitForSlot, postSleep } from '../lib/rate-limiter.mjs';
import { sendAlert } from '../lib/telegram.mjs';

const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4h freshness window

function buildAmplifyComment(aiComment, ownerUrl) {
  // Append reference to owner's tweet
  const trimmed = aiComment.replace(/\s+$/, '');
  const total = trimmed + ' — ' + ownerUrl;
  return total.length > 270 ? trimmed.slice(0, 230) + '... ' + ownerUrl : total;
}

export async function runAmplifyMode(cfg, log) {
  const owner = cfg.modeB?.ownerUsername;
  if (!owner) {
    log('[mode-B] ownerUsername not configured; skipping');
    return;
  }
  const hashtags = cfg.modeB?.hashtags || ['#XAUUSD', '#Gold', '#Crypto', '#Bitcoin'];

  // 1. Get owner's newest non-retweet, non-reply tweet
  let ownerTweets;
  try {
    ownerTweets = await searchUserTweets(owner, cfg.cookiesFile, 10);
  } catch (e) {
    log(`[mode-B] cannot fetch owner tweets: ${e.message}`);
    if (/401|403/.test(e.message)) {
      await sendAlert(cfg.telegram?.botToken, cfg.telegram?.chatId, `[twitter-comment-pack] Session expired`);
    }
    return;
  }
  const candidates = ownerTweets.filter((t) => !t.isRetweet && !t.inReplyToStatusId);
  if (candidates.length === 0) {
    log('[mode-B] no eligible owner tweets');
    return;
  }
  candidates.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const own = candidates[0];

  if (Date.now() - new Date(own.createdAt).getTime() > MAX_AGE_MS) {
    log(`[mode-B] owner's latest tweet too old (>${MAX_AGE_MS / 3600000}h); skipping`);
    return;
  }

  const ownUrl = `https://x.com/${owner}/status/${own.id}`;
  const lastSeen = getMeta('amplify_last_owner_id');
  if (lastSeen !== own.id) {
    log(`[mode-B] new owner tweet ${own.id} → amplifying`);
    setMeta('amplify_last_owner_id', own.id);
  }

  // Optional cross-post to a list (just post a quote-style mention)
  const crossListId = (cfg.modeB?.crossPostListId || '').trim();
  if (crossListId) {
    try {
      // simply note in log — list cross-post is a hint feature
      const ts = await fetchListTweets(crossListId, cfg.cookiesFile, 1);
      log(`[mode-B] crossPostListId reachable (${ts.length} tweets sample)`);
    } catch (e) {
      log(`[mode-B] crossPostListId fetch failed: ${e.message}`);
    }
  }

  // 2. For each hashtag, find candidates and reply
  for (const tag of hashtags) {
    let cursor = null;
    for (let page = 0; page < 2; page++) {
      let result;
      try {
        result = await searchTimeline(tag, cfg.cookiesFile, cursor, 'Latest');
      } catch (e) {
        log(`[mode-B] search ${tag} p${page} failed: ${e.message}`);
        if (/RATE_LIMITED/.test(e.message)) {
          await sendAlert(cfg.telegram?.botToken, cfg.telegram?.chatId, `[twitter-comment-pack] Rate limited on search`);
          return;
        }
        break;
      }
      if (result.tweets.length === 0) break;

      for (const t of result.tweets) {
        if (t.isRetweet) continue;
        if (t.author?.toLowerCase() === owner.toLowerCase()) continue;
        const age = Date.now() - new Date(t.createdAt).getTime();
        if (age > MAX_AGE_MS) continue;
        if (alreadyCommented(t.id)) continue;

        await waitForSlot(cfg, log);
        const lang = detectLanguage(t.fullText);
        let aiText;
        try {
          aiText = await generateComment({
            tweetText: t.fullText,
            lang,
            style: cfg.modeA?.stylePrompt || '',
            ai: cfg.ai,
          });
        } catch (e) {
          log(`[mode-B] AI fail ${t.id}: ${e.message}`);
          continue;
        }
        const reply = buildAmplifyComment(aiText, ownUrl);
        try {
          await postTweet(reply, cfg.cookiesFile, { replyToId: t.id });
          markCommented(t.id, t.author);
          log(`[mode-B] OK ${t.id} @${t.author} tag=${tag} lang=${lang}`);
        } catch (e) {
          log(`[mode-B] post fail ${t.id}: ${e.message}`);
          if (/RATE_LIMITED/.test(e.message)) {
            await sendAlert(cfg.telegram?.botToken, cfg.telegram?.chatId, `[twitter-comment-pack] Rate limited`);
            return;
          }
          continue;
        }
        await postSleep(cfg, log);
      }

      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
  }
}
