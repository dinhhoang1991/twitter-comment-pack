/**
 * Mode A — crawl one or more lists, comment on each unique tweet using
 * the configured language + style.
 */
import { fetchListTweets, postTweet } from '../lib/twitter-http.mjs';
import { detectLanguage } from '../lib/language.mjs';
import { generateComment } from '../lib/ai-commenter.mjs';
import { alreadyCommented, markCommented } from '../lib/store.mjs';
import { waitForSlot, postSleep } from '../lib/rate-limiter.mjs';
import { sendAlert } from '../lib/telegram.mjs';

export async function runListMode(cfg, log) {
  const listIds = cfg.modeA?.listIds || [];
  if (listIds.length === 0) {
    log('[mode-A] no list IDs configured; skipping');
    return;
  }

  const pool = [];
  const seen = new Set();
  for (const id of listIds) {
    try {
      const tweets = await fetchListTweets(String(id).trim(), cfg.cookiesFile, 30);
      for (const t of tweets) {
        if (!t.id || !t.fullText || t.fullText.length < 10) continue;
        if (t.isRetweet) continue;
        if (seen.has(t.id)) continue;
        if (alreadyCommented(t.id)) continue;
        seen.add(t.id);
        pool.push(t);
      }
      log(`[mode-A] list ${id}: pool size now ${pool.length}`);
    } catch (e) {
      log(`[mode-A] list ${id} fetch failed: ${e.message}`);
      if (/401|403/.test(e.message)) {
        await sendAlert(cfg.telegram?.botToken, cfg.telegram?.chatId, `[twitter-comment-pack] Session expired — re-export cookies`);
        throw e;
      }
    }
  }

  pool.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  for (const t of pool) {
    await waitForSlot(cfg, log);
    const langSetting = cfg.modeA?.language || 'auto';
    const lang = langSetting === 'auto' ? detectLanguage(t.fullText) : langSetting;

    let comment;
    try {
      comment = await generateComment({
        tweetText: t.fullText,
        lang,
        style: cfg.modeA?.stylePrompt || '',
        ai: cfg.ai,
      });
    } catch (e) {
      log(`[mode-A] AI fail for ${t.id}: ${e.message}`);
      continue;
    }

    try {
      await postTweet(comment, cfg.cookiesFile, { replyToId: t.id });
      markCommented(t.id, t.author);
      log(`[mode-A] OK reply ${t.id} @${t.author} lang=${lang} "${comment.slice(0, 60)}..."`);
    } catch (e) {
      log(`[mode-A] post fail ${t.id}: ${e.message}`);
      if (/RATE_LIMITED/.test(e.message)) {
        await sendAlert(cfg.telegram?.botToken, cfg.telegram?.chatId, `[twitter-comment-pack] Rate limited (${e.message})`);
        return;
      }
      continue;
    }
    await postSleep(cfg, log);
  }
}
