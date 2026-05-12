/**
 * Mode C — alternate Mode A and Mode B every iteration.
 */
import { runListMode } from './list-comment.mjs';
import { runAmplifyMode } from './amplify.mjs';
import { getMeta, setMeta } from '../lib/store.mjs';

export async function runHybridMode(cfg, log) {
  const last = getMeta('hybrid_last') || 'B';
  if (last === 'B') {
    log('[mode-C] running A');
    await runListMode(cfg, log);
    setMeta('hybrid_last', 'A');
  } else {
    log('[mode-C] running B');
    await runAmplifyMode(cfg, log);
    setMeta('hybrid_last', 'B');
  }
}
