import Database from 'better-sqlite3';
import { initStore } from './src/lib/store.mjs';

initStore('data/store.db');

const db = new Database('data/store.db');
db.pragma('journal_mode = WAL');

const users = [
  // === THAY BẰNG USER THẬT BẠN MUỐN SEED ===
  { id: '1234567890', username: 'crypto_alpha' },
  { id: '2345678901', username: 'solana_gem_finder' },
  { id: '3456789012', username: 'base_narratives' },
  { id: '4567890123', username: 'airdrop_alpha' },
  { id: '5678901234', username: 'moon_bullish' },
  { id: '6789012345', username: 'defi_narratives' },
];

const stmt = db.prepare(`
  INSERT OR REPLACE INTO engaged_users (user_id, username, last_interact_ts, interaction_count)
  VALUES (?, ?, ?, ?)
`);

for (const u of users) {
  stmt.run(u.id, u.username, Date.now(), 3);
}

console.log('Seeded', users.length, 'users');
console.log('Total engaged users:', db.prepare('SELECT COUNT(*) as c FROM engaged_users').get().c);
db.close();
