import { postTweet } from '../lib/twitter-http.mjs';
import { generateComment } from '../lib/ai-commenter.mjs';
import { waitForSlot } from '../lib/rate-limiter.mjs';
import { sendAlert } from '../lib/telegram.mjs';

export async function runAutoPostMode(cfg, log) {
  if (typeof log !== 'function') log = (msg) => process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
  const modeCfg = cfg.modeE || {};
  const topics = modeCfg.topics || ['crypto alpha', 'airdrop', 'narrative', 'solana ecosystem', 'base chain'];
  const postsPerDay = modeCfg.postsPerDay || 3;
  const maxLength = modeCfg.maxLength || 240;

  const topic = topics[Math.floor(Math.random() * topics.length)];

  log(`[mode-E] Generating post about: ${topic}`);

  try {
    await waitForSlot(cfg, log);

    const prompt = `Write a short, natural Twitter post (under ${maxLength} characters) about ${topic}. 
Make it sound like a real crypto trader: insightful, slightly casual, no hashtags, no links, no emojis unless necessary. 
Only output the tweet text.`;

    const tweetText = await generateComment({
      tweetText: prompt,
      lang: modeCfg.lang || 'en',
      style: modeCfg.style || cfg.ai?.style || 'casual crypto trader',
      ai: cfg.ai
    });

    if (!tweetText || tweetText.length < 10) {
      log('[mode-E] Generated text too short, skipping');
      return;
    }

    const cleanText = tweetText.replace(/^["'`]+|[\"'`]+$/g, '').trim();

    await postTweet(cleanText, cfg.cookiesFile);
    log(`[mode-E] Posted: ${cleanText.slice(0, 80)}...`);

    if (cfg.telegram?.botToken) {
      await sendAlert(cfg.telegram.botToken, cfg.telegram.chatId, `Mode E: Posted new tweet\nTopic: ${topic}`);
    }
  } catch (e) {
    log(`[mode-E] Error: ${e.message}`);
  }
}
