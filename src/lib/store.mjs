import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db = null;

export function initStore(dbPath = 'data/store.db') {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  try { db.exec('ALTER TABLE commented ADD COLUMN comment_count INTEGER DEFAULT 1'); } catch {}
  db.exec(`

    CREATE TABLE IF NOT EXISTS commented (
      tweet_id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      author TEXT,
      comment_count INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_commented_ts ON commented(ts);

    CREATE TABLE IF NOT EXISTS viral_tweets (
      tweet_id TEXT PRIMARY KEY,
      first_seen_ts INTEGER NOT NULL,
      last_seen_ts INTEGER NOT NULL,
      seen_count INTEGER DEFAULT 1,
      first_reply_count INTEGER,
      latest_reply_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_viral_latest ON viral_tweets(seen_count DESC, latest_reply_count DESC);

    CREATE TABLE IF NOT EXISTS warmup_state (
      target TEXT NOT NULL,
      tweet_id TEXT NOT NULL,
      action TEXT NOT NULL,
      last_action_ts INTEGER NOT NULL,
      PRIMARY KEY(target, tweet_id, action)
    );

    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );

    CREATE TABLE IF NOT EXISTS engaged_users (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      last_interact_ts INTEGER NOT NULL,
      interaction_count INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS follows (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      followed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mutuals (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      discovered_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trend_words (
      word TEXT PRIMARY KEY,
      cnt INTEGER DEFAULT 1,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS my_replies (
      tweet_id TEXT PRIMARY KEY,
      root_tweet_id TEXT,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reply_feedback (
      tweet_id TEXT PRIMARY KEY,
      engagement_style TEXT,
      persona TEXT,
      likes_got INTEGER DEFAULT 0,
      replies_got INTEGER DEFAULT 0,
      checked_at INTEGER,
      posted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_checked ON reply_feedback(checked_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_style ON reply_feedback(engagement_style);

    CREATE TABLE IF NOT EXISTS auto_post_feedback (
      tweet_id TEXT PRIMARY KEY,
      token_ticker TEXT,
      token_name TEXT,
      lang TEXT,
      thread_size INTEGER,
      likes_got INTEGER DEFAULT 0,
      replies_got INTEGER DEFAULT 0,
      retweets_got INTEGER DEFAULT 0,
      quotes_got INTEGER DEFAULT 0,
      checked_at INTEGER,
      posted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apf_checked ON auto_post_feedback(checked_at);

    CREATE TABLE IF NOT EXISTS followers (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      discovered_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_followers_user ON followers(username);
  `);
  return db;
}

export function getCommentCount(tweetId) {
  if (!db) return 0;
  const row = db.prepare('SELECT comment_count FROM commented WHERE tweet_id = ?').get(tweetId);
  return row ? row.comment_count : 0;
}

export function alreadyCommented(tweetId) {
  if (!db) return false;
  return getCommentCount(tweetId) >= 1;
}

export function markCommented(tweetId, author = '') {
  db.prepare(`
    INSERT INTO commented(tweet_id, ts, author, comment_count)
    VALUES(?, ?, ?, 1)
    ON CONFLICT(tweet_id) DO UPDATE SET
      ts = excluded.ts,
      comment_count = comment_count + 1,
      author = COALESCE(excluded.author, author)
  `).run(tweetId, Date.now(), author);
}

export function commentsInLastHour() {
  if (!db) return 0;
  const since = Date.now() - 60 * 60 * 1000;
  const row = db.prepare('SELECT COUNT(*) AS c FROM commented WHERE ts >= ?').get(since);
  return row.c;
}

export function warmupSeen(target, tweetId, action) {
  if (!db) return false;
  const row = db.prepare(
    'SELECT 1 FROM warmup_state WHERE target = ? AND tweet_id = ? AND action = ?'
  ).get(target, tweetId, action);
  return !!row;
}

export function warmupMark(target, tweetId, action) {
  db.prepare(
    'INSERT OR REPLACE INTO warmup_state(target, tweet_id, action, last_action_ts) VALUES(?, ?, ?, ?)'
  ).run(target, tweetId, action, Date.now());
}

export function getMeta(k) {
  if (!db) return null;
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return row ? row.v : null;
}

export function setMeta(k, v) {
  db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)').run(k, String(v));
}

export function isEngagedUser(userId) {
  if (!db || !userId) return false;
  const row = db.prepare('SELECT 1 FROM engaged_users WHERE user_id = ?').get(userId);
  return !!row;
}

export function markUserEngaged(userId, username = '') {
  if (!db || !userId) return;
  db.prepare(`
    INSERT INTO engaged_users (user_id, username, last_interact_ts, interaction_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(user_id) DO UPDATE SET
      last_interact_ts = excluded.last_interact_ts,
      interaction_count = interaction_count + 1,
      username = COALESCE(excluded.username, username)
  `).run(userId, username, Date.now());
}

export function getEngagedUserCount() {
  if (!db) return 0;
  const row = db.prepare('SELECT COUNT(*) AS c FROM engaged_users').get();
  return row.c;
}

// Viral tweet tracking
export function seeViralTweet(tweetId, replyCount) {
  if (!db) return;
  db.prepare(`
    INSERT INTO viral_tweets(tweet_id, first_seen_ts, last_seen_ts, seen_count, first_reply_count, latest_reply_count)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(tweet_id) DO UPDATE SET
      last_seen_ts = ?,
      seen_count = seen_count + 1,
      latest_reply_count = ?
  `).run(tweetId, Date.now(), Date.now(), replyCount, replyCount, Date.now(), replyCount);
}

export function getViralTweets(minSeen = 3, minGrowth = 5) {
  if (!db) return [];
  const rows = db.prepare(`
    SELECT tweet_id, first_seen_ts, seen_count,
           COALESCE(latest_reply_count, 0) - COALESCE(first_reply_count, 0) AS growth
    FROM viral_tweets
    WHERE seen_count >= ?
      AND first_seen_ts > ?
    ORDER BY growth DESC, seen_count DESC
    LIMIT 20
  `).all(minSeen, Date.now() - 48 * 60 * 60 * 1000);
  return rows;
}

export function cleanupOldViralTweets() {
  if (!db) return;
  db.prepare('DELETE FROM viral_tweets WHERE last_seen_ts < ?').run(Date.now() - 48 * 60 * 60 * 1000);
}

export function getViralStats() {
  if (!db) return null;
  const row = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(growth),0) AS total_growth
    FROM viral_tweets WHERE seen_count >= 3
  `).get();
  return row;
}

// Warmup tracking
export function isWarmedUp(target) {
  if (!db) return false;
  return !!db.prepare('SELECT 1 FROM warmed_up WHERE user_id = ?').get(target);
}

export function markWarmedUp(target) {
  if (!db) return;
  db.prepare('INSERT OR IGNORE INTO warmed_up(user_id) VALUES(?)').run(target);
}

export function trackFollow(userId, username) {
  if (!db || !userId) return;
  db.prepare('INSERT OR IGNORE INTO follows(user_id, username, followed_at) VALUES(?, ?, ?)')
    .run(userId, username || '', Date.now());
}

export function isFollowing(userId) {
  if (!db || !userId) return false;
  const row = db.prepare('SELECT 1 FROM follows WHERE user_id = ?').get(userId);
  return !!row;
}

export function getStaleFollows(days = 3) {
  if (!db) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.prepare('SELECT user_id, username FROM follows WHERE followed_at < ?').all(cutoff);
}

export function removeFollowRecord(userId) {
  if (!db) return;
  db.prepare('DELETE FROM follows WHERE user_id = ?').run(userId);
}

export function markMutual(userId, username) {
  if (!db || !userId) return;
  db.prepare('INSERT OR IGNORE INTO mutuals(user_id, username, discovered_at) VALUES(?, ?, ?)')
    .run(userId, username || '', Date.now());
}

export function isMutual(userId) {
  if (!db || !userId) return false;
  return !!db.prepare('SELECT 1 FROM mutuals WHERE user_id = ?').get(userId);
}

export function getMutuals() {
  if (!db) return [];
  return db.prepare('SELECT user_id, username FROM mutuals ORDER BY discovered_at DESC LIMIT 50').all();
}

export function getMutualCount() {
  if (!db) return 0;
  return db.prepare('SELECT COUNT(*) AS c FROM mutuals').get().c;
}

export function getTrendKeywords() {
  if (!db) return [];
  const since = Date.now() - 60 * 60 * 1000;
  return db.prepare('SELECT word, cnt FROM trend_words WHERE last_seen > ? ORDER BY cnt DESC LIMIT 10').all(since);
}

export function bumpTrendWord(word) {
  if (!db || !word || word.length < 3) return;
  db.prepare(`
    INSERT INTO trend_words(word, cnt, last_seen) VALUES(?, 1, ?)
    ON CONFLICT(word) DO UPDATE SET cnt = cnt + 1, last_seen = ?
  `).run(word.toLowerCase(), Date.now(), Date.now());
}

export function cleanupTrendWords() {
  if (!db) return;
  db.prepare('DELETE FROM trend_words WHERE last_seen < ?').run(Date.now() - 2 * 60 * 60 * 1000);
}

export function trackMyReply(replyTweetId, rootTweetId) {
  if (!db || !replyTweetId) return;
  db.prepare('INSERT OR IGNORE INTO my_replies(tweet_id, root_tweet_id, ts) VALUES(?, ?, ?)')
    .run(replyTweetId, rootTweetId || null, Date.now());
}

export function isReplyToMyComment(inReplyToTweetId) {
  if (!db || !inReplyToTweetId) return false;
  return !!db.prepare('SELECT 1 FROM my_replies WHERE tweet_id = ?').get(inReplyToTweetId);
}

export function trackReplyFeedback(tweetId, engagementStyle, persona) {
  if (!db || !tweetId) return;
  db.prepare(`INSERT OR IGNORE INTO reply_feedback(tweet_id, engagement_style, persona, posted_at)
    VALUES(?, ?, ?, ?)`).run(tweetId, engagementStyle || '', persona || '', Date.now());
}

export function updateReplyFeedback(tweetId, likes, replies) {
  if (!db || !tweetId) return;
  db.prepare(`UPDATE reply_feedback SET likes_got=?, replies_got=?, checked_at=? WHERE tweet_id=?`)
    .run(likes || 0, replies || 0, Date.now(), tweetId);
}

export function getUncheckedFeedback(minAgeMs = 3600000, limit = 10) {
  if (!db) return [];
  const cutoff = Date.now() - minAgeMs;
  return db.prepare(`SELECT tweet_id, engagement_style, persona FROM reply_feedback
    WHERE (checked_at IS NULL OR checked_at < ?) AND posted_at < ?
    ORDER BY posted_at ASC LIMIT ?`).all(cutoff, cutoff, limit);
}

export function getBestStyles(minSamples = 3) {
  if (!db) return [];
  return db.prepare(`SELECT engagement_style, COUNT(*) as n,
    CAST(SUM(likes_got + replies_got * 2) AS REAL) / MAX(COUNT(*), 1) as score
    FROM reply_feedback WHERE checked_at IS NOT NULL
    GROUP BY engagement_style HAVING n >= ? ORDER BY score DESC`).all(minSamples);
}

export function getBestPersonas(minSamples = 3) {
  if (!db) return [];
  return db.prepare(`SELECT persona, COUNT(*) as n,
    CAST(SUM(likes_got + replies_got * 2) AS REAL) / MAX(COUNT(*), 1) as score
    FROM reply_feedback WHERE checked_at IS NOT NULL AND persona != ''
    GROUP BY persona HAVING n >= ? ORDER BY score DESC`).all(minSamples);
}

export function cleanupOldFeedback(maxAgeMs = 7 * 24 * 3600000) {
  if (!db) return;
  db.prepare('DELETE FROM reply_feedback WHERE posted_at < ?').run(Date.now() - maxAgeMs);
}

export function trackAutoPost(tweetId, tokenTicker, tokenName, lang, threadSize) {
  if (!db || !tweetId) return;
  db.prepare(`INSERT OR IGNORE INTO auto_post_feedback(tweet_id, token_ticker, token_name, lang, thread_size, posted_at)
    VALUES(?, ?, ?, ?, ?, ?)`).run(tweetId, tokenTicker || '', tokenName || '', lang || '', threadSize || 0, Date.now());
}

export function updateAutoPostEngagement(tweetId, likes, replies, retweets, quotes) {
  if (!db || !tweetId) return;
  db.prepare(`UPDATE auto_post_feedback SET likes_got=?, replies_got=?, retweets_got=?, quotes_got=?, checked_at=? WHERE tweet_id=?`)
    .run(likes || 0, replies || 0, retweets || 0, quotes || 0, Date.now(), tweetId);
}

export function getUncheckedAutoPosts(minAgeMs = 7200000, limit = 5) {
  if (!db) return [];
  const cutoff = Date.now() - minAgeMs;
  return db.prepare(`SELECT tweet_id, token_ticker, lang FROM auto_post_feedback
    WHERE (checked_at IS NULL OR checked_at < ?) AND posted_at < ?
    ORDER BY posted_at ASC LIMIT ?`).all(cutoff, cutoff, limit);
}

export function getAutoPostStats() {
  if (!db) return null;
  const row = db.prepare(`SELECT COUNT(*) as total,
    CAST(SUM(likes_got) AS REAL) / MAX(COUNT(*), 1) as avg_likes,
    CAST(SUM(replies_got) AS REAL) / MAX(COUNT(*), 1) as avg_replies,
    SUM(likes_got) as total_likes, SUM(replies_got) as total_replies
    FROM auto_post_feedback WHERE checked_at IS NOT NULL`).get();
  return row;
}

export function getBestAutoPostTokens(minSamples = 2) {
  if (!db) return [];
  return db.prepare(`SELECT token_ticker, token_name, COUNT(*) as n,
    CAST(SUM(likes_got + replies_got * 2 + retweets_got * 3) AS REAL) / MAX(COUNT(*), 1) as score
    FROM auto_post_feedback WHERE checked_at IS NOT NULL AND token_ticker != ''
    GROUP BY token_ticker HAVING n >= ? ORDER BY score DESC LIMIT 5`).all(minSamples);
}

export function isFollower(userId) {
  if (!db || !userId) return false;
  return !!db.prepare('SELECT 1 FROM followers WHERE user_id = ?').get(userId);
}

export function markFollower(userId, username) {
  if (!db || !userId) return;
  db.prepare('INSERT OR IGNORE INTO followers(user_id, username, discovered_at) VALUES(?, ?, ?)')
    .run(userId, username || '', Date.now());
}
