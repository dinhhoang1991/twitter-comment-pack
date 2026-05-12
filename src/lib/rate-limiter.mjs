import { commentsInLastHour } from './store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForSlot(cfg, log) {
  while (true) {
    const cap = cfg.commentsPerHour;
    const count = commentsInLastHour();
    if (count < cap) return;
    const waitMs = 5 * 60_000 + Math.floor(Math.random() * 60_000);
    log(`[rate] cap ${count}/${cap} reached — sleeping ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
}

export async function postSleep(cfg, log) {
  const { delayMinMs = 60_000, delayMaxMs = 240_000 } = cfg;
  const ms = delayMinMs + Math.floor(Math.random() * Math.max(1, delayMaxMs - delayMinMs));
  log(`[rate] post-sleep ${Math.round(ms / 1000)}s`);
  await sleep(ms);
}
