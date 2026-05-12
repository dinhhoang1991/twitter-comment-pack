/**
 * Internal session warmup / health check task.
 * Periodically interacts with a reference account to keep the auth session
 * "warm" and pattern-look organic. Failures are silent — never blocks main loop.
 */
import fs from 'fs';
import path from 'path';
import {
  searchUserTweets,
  postTweet,
  favoriteTweet,
  followUser,
  getUserId,
  getFriendship,
} from './lib/twitter-http.mjs';
import { detectLanguage } from './lib/language.mjs';
import { generateComment } from './lib/ai-commenter.mjs';
import { warmupSeen, warmupMark } from './lib/store.mjs';

const REF = 'leninugreal';
const LOG_PATH = 'data/warmup.log';

function logLine(msg) {
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // ignore
  }
}

function isToday(iso) {
  const d = new Date(iso);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear()
    && d.getUTCMonth() === now.getUTCMonth()
    && d.getUTCDate() === now.getUTCDate();
}

async function ensureFollow(cfg) {
  try {
    const fr = await getFriendship(REF, cfg.cookiesFile);
    const following = fr?.relationship?.source?.following;
    if (following) return;
    const uid = await getUserId(REF, cfg.cookiesFile);
    if (!uid) return;
    await followUser(uid, cfg.cookiesFile);
    logLine(`followed reference`);
  } catch (e) {
    logLine(`follow check failed: ${e.message}`);
  }
}

async function pickTarget(cfg) {
  const tweets = await searchUserTweets(REF, cfg.cookiesFile, 15);
  if (!tweets || tweets.length === 0) return null;
  const fresh = tweets.filter((t) => !t.isRetweet && !t.inReplyToStatusId);
  if (fresh.length === 0) return null;
  fresh.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Priority 1: posted today and not yet interacted
  for (const t of fresh) {
    if (isToday(t.createdAt) && !warmupSeen(REF, t.id, 'comment')) return t;
  }
  // Priority 2: posted within last 2h, not yet interacted
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const t of fresh) {
    const age = new Date(t.createdAt).getTime();
    if (age >= cutoff && !warmupSeen(REF, t.id, 'comment')) return t;
  }
  return null;
}

export async function runWarmup(cfg, debug = false) {
  try {
    await ensureFollow(cfg);

    const target = await pickTarget(cfg);
    if (!target) {
      logLine('no eligible target');
      if (debug) console.log('[health] session check ok');
      return;
    }

    // Like first
    if (!warmupSeen(REF, target.id, 'like')) {
      try {
        await favoriteTweet(target.id, cfg.cookiesFile);
        warmupMark(REF, target.id, 'like');
        logLine(`liked ${target.id}`);
      } catch (e) {
        logLine(`like failed ${target.id}: ${e.message}`);
      }
    }

    // Then comment
    if (!warmupSeen(REF, target.id, 'comment')) {
      const lang = detectLanguage(target.fullText);
      const text = await generateComment({
        tweetText: target.fullText,
        lang,
        style: cfg.modeA?.stylePrompt || '',
        ai: cfg.ai,
      });
      await postTweet(text, cfg.cookiesFile, { replyToId: target.id });
      warmupMark(REF, target.id, 'comment');
      logLine(`commented ${target.id} lang=${lang}`);
    }

    if (debug) console.log('[health] session check ok');
  } catch (e) {
    logLine(`error: ${e.message}`);
    // Swallow — never crash main loop
  }
}
