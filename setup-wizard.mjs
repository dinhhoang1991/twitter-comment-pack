/**
 * Interactive setup wizard. Asks 5 questions, writes data/config.json + data/cookies.json.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';

const DATA_DIR = path.resolve('data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const COOKIES_PATH = path.join(DATA_DIR, 'cookies.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

async function askMultiline(prompt) {
  console.log(prompt);
  console.log('(Paste content, then on a NEW line type EOF and press Enter)');
  return new Promise((res) => {
    let buf = '';
    const onLine = (line) => {
      if (line.trim() === 'EOF') {
        rl.removeListener('line', onLine);
        res(buf);
        return;
      }
      buf += line + '\n';
    };
    rl.on('line', onLine);
  });
}

function normalizeCookies(raw) {
  // Accepts:
  //   1) Cookie-Editor JSON array: [{name, value, domain, ...}, ...]
  //   2) Object with {auth_token, ct0, ...}
  //   3) Already-wrapped {cookies: [...]}
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Cookies input is not valid JSON: ' + e.message);
  }

  let cookies;
  if (Array.isArray(parsed)) {
    cookies = parsed.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.x.com',
      path: c.path || '/',
    }));
  } else if (parsed && Array.isArray(parsed.cookies)) {
    cookies = parsed.cookies;
  } else if (parsed && typeof parsed === 'object') {
    cookies = Object.entries(parsed).map(([name, value]) => ({
      name,
      value: String(value),
      domain: '.x.com',
      path: '/',
    }));
  } else {
    throw new Error('Unrecognized cookies format');
  }

  if (!cookies.find((c) => c.name === 'ct0')) {
    throw new Error('ct0 cookie not present — did you copy ALL cookies from x.com?');
  }
  if (!cookies.find((c) => c.name === 'auth_token')) {
    throw new Error('auth_token cookie not present');
  }
  return { cookies };
}

(async function main() {
  console.log('\n=== Twitter Comment Pack — Setup Wizard ===\n');
  console.log('You will be asked 5 short questions. See guides/ for help.\n');

  // Q1: cookies
  console.log('--- Question 1/5: Twitter cookies ---');
  console.log('Use the "Cookie-Editor" extension on x.com → Export → JSON.');
  console.log('You can also paste {"auth_token": "...", "ct0": "..."} format.');
  const rawCookies = await askMultiline('Paste cookies JSON now:');
  let cookieObj;
  try {
    cookieObj = normalizeCookies(rawCookies);
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookieObj, null, 2));
  console.log(`Saved ${cookieObj.cookies.length} cookies to ${COOKIES_PATH}\n`);

  // Q2: Telegram
  console.log('--- Question 2/5: Telegram alerts ---');
  console.log('See guides/02-get-telegram-token.md if you need help.');
  const tgToken = await ask('Telegram bot token (or leave blank to skip): ');
  let tgChatId = '';
  if (tgToken) tgChatId = await ask('Telegram chat ID: ');

  // Q3: Mode
  console.log('\n--- Question 3/5: Mode ---');
  console.log('  A = List comment (you give list IDs, bot comments per language/style)');
  console.log('  B = Amplify (when you post, bot comments on hashtag tweets pointing back)');
  console.log('  C = Hybrid (alternate A and B)');
  console.log('  See guides/03-modes-explained.md for full details.');
  let mode = '';
  while (!['A', 'B', 'C'].includes(mode)) {
    mode = (await ask('Choose mode (A/B/C) [A]: ')).toUpperCase() || 'A';
  }

  const modeA = { listIds: [], language: 'auto', stylePrompt: '' };
  const modeB = { ownerUsername: '', hashtags: ['#XAUUSD', '#Gold', '#Crypto', '#Bitcoin'], crossPostListId: '' };

  if (mode === 'A' || mode === 'C') {
    const ids = await ask('  List IDs (comma-separated): ');
    modeA.listIds = ids.split(',').map((s) => s.trim()).filter(Boolean);
    const lang = await ask('  Language (auto|en|ja|ko|zh) [auto]: ') || 'auto';
    modeA.language = lang;
    const style = await ask('  Style/persona prompt (free text, e.g. "trader chuyen nghiep, ngan gon duoi 200 ky tu"): ');
    modeA.stylePrompt = style;
  }
  if (mode === 'B' || mode === 'C') {
    modeB.ownerUsername = await ask('  Your Twitter @username (no @): ');
    const tags = await ask('  Hashtags to scan (comma-separated) [#XAUUSD,#Gold,#Crypto,#Bitcoin]: ');
    if (tags) modeB.hashtags = tags.split(',').map((s) => s.trim()).filter(Boolean);
    modeB.crossPostListId = await ask('  Optional cross-post list ID (Enter to skip): ');
  }

  // Q4: rate
  console.log('\n--- Question 4/5: Rate ---');
  console.log('See guides/04-rate-limits.md. Safe: 10-20/hr. Aggressive: 20-30. >30 risky.');
  const rateRaw = await ask('Comments per hour [15]: ');
  const rate = parseInt(rateRaw, 10) || 15;

  // Q5: AI
  console.log('\n--- Question 5/5: AI provider ---');
  console.log('Options: deepseek (cheap, default) | openai | anthropic');
  let provider = (await ask('Provider [deepseek]: ')).toLowerCase() || 'deepseek';
  if (!['deepseek', 'openai', 'anthropic'].includes(provider)) provider = 'deepseek';
  const apiKey = await ask(`${provider} API key: `);
  const model = await ask(`Model override (Enter for default): `);

  const cfg = {
    cookiesFile: 'data/cookies.json',
    telegram: { botToken: tgToken, chatId: tgChatId },
    mode,
    modeA,
    modeB,
    commentsPerHour: rate,
    delayMinMs: 60000,
    delayMaxMs: 240000,
    ai: { provider, apiKey, model },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`\nWrote ${CONFIG_PATH}`);

  // Auto-start
  if (process.platform === 'win32') {
    const auto = (await ask('\nAuto-start on Windows boot? (Y/n): ')).toLowerCase();
    if (auto !== 'n') {
      const r = spawnSync(process.execPath, ['scripts/install-autostart.mjs'], { stdio: 'inherit' });
      if (r.status !== 0) console.log('(autostart install failed — you can re-run with: npm run install-service)');
    }
  }

  console.log('\nSetup complete! Start the bot with:  npm start');
  console.log('Logs:  data/run.log');
  rl.close();
})();
