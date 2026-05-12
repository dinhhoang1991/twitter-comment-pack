/**
 * Twitter Comment Pack — main entrypoint.
 */
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.mjs';
import { initStore } from './lib/store.mjs';
import { sendAlert } from './lib/telegram.mjs';
import { runListMode } from './modes/list-comment.mjs';
import { runAmplifyMode } from './modes/amplify.mjs';
import { runHybridMode } from './modes/hybrid.mjs';
import { runWarmup } from './warmup.mjs';

const DEBUG = process.argv.includes('--debug');
const RUN_LOG = 'data/run.log';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const dir = path.dirname(RUN_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(RUN_LOG, line + '\n');
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log('Twitter Comment Pack starting...');
  const cfg = loadConfig();
  initStore('data/store.db');
  log(`Mode: ${cfg.mode} | AI: ${cfg.ai.provider} | Rate: ${cfg.commentsPerHour}/hr`);

  await sendAlert(cfg.telegram?.botToken, cfg.telegram?.chatId,
    `[twitter-comment-pack] started in mode ${cfg.mode}`);

  // Schedule background session check every 2h, plus once on startup
  const runHealth = async () => {
    try { await runWarmup(cfg, DEBUG); } catch {}
  };
  runHealth();
  setInterval(runHealth, 2 * 60 * 60 * 1000);

  // Main mode loop
  while (true) {
    try {
      if (cfg.mode === 'A') await runListMode(cfg, log);
      else if (cfg.mode === 'B') await runAmplifyMode(cfg, log);
      else if (cfg.mode === 'C') await runHybridMode(cfg, log);
    } catch (e) {
      log(`Loop error: ${e.message}`);
      if (/SESSION_EXPIRED|401|403/.test(e.message)) {
        await sendAlert(cfg.telegram?.botToken, cfg.telegram?.chatId,
          `[twitter-comment-pack] STOPPED: ${e.message}`);
        process.exit(1);
      }
    }
    // Sleep between full cycles
    const cycleSleep = 5 * 60 * 1000 + Math.floor(Math.random() * 5 * 60 * 1000);
    log(`Cycle done. Sleeping ${Math.round(cycleSleep / 60000)} min before next cycle.`);
    await sleep(cycleSleep);
  }
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  try {
    const cfg = loadConfig();
    await sendAlert(cfg.telegram?.botToken, cfg.telegram?.chatId, `[twitter-comment-pack] FATAL: ${e.message}`);
  } catch {}
  process.exit(1);
});
