/**
 * Create a Windows Scheduled Task that runs the bot on logon + at startup.
 * Idempotent (uses /F to overwrite). Non-Windows just prints a hint.
 */
import path from 'path';
import { spawnSync } from 'child_process';
import process from 'process';

const TASK_NAME = 'TwitterCommentPack';

if (process.platform !== 'win32') {
  console.log('Manual setup required on this OS.');
  console.log('Suggested: create a systemd unit / launchd plist running:');
  console.log(`  ${process.execPath} ${path.resolve('src/index.mjs')}`);
  process.exit(0);
}

const node = process.execPath;
const entry = path.resolve('src/index.mjs');
const cwd = path.resolve('.');

// Build a wrapper command so cwd is correct
const cmdLine = `cmd /c cd /d "${cwd}" && "${node}" "${entry}" >> "${path.join(cwd, 'data', 'run.log')}" 2>&1`;

console.log(`Installing scheduled task "${TASK_NAME}"...`);
console.log(`  Node:  ${node}`);
console.log(`  Entry: ${entry}`);
console.log(`  CWD:   ${cwd}`);

// Create ONLOGON
let r = spawnSync('schtasks.exe', [
  '/Create', '/TN', TASK_NAME,
  '/TR', cmdLine,
  '/SC', 'ONLOGON',
  '/RL', 'HIGHEST',
  '/F',
], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('schtasks ONLOGON failed (exit', r.status, ')');
  process.exit(r.status || 1);
}

// Add an extra ONSTART trigger by creating a second task name? schtasks /Create only allows one trigger.
// Workaround: also create an ONSTART task with same command so it survives logout.
const startupTask = TASK_NAME + '_Startup';
r = spawnSync('schtasks.exe', [
  '/Create', '/TN', startupTask,
  '/TR', cmdLine,
  '/SC', 'ONSTART',
  '/RU', 'SYSTEM',
  '/RL', 'HIGHEST',
  '/F',
], { stdio: 'inherit' });
if (r.status !== 0) {
  console.warn(`(Note: ONSTART task creation returned exit ${r.status} — ONLOGON task still installed.)`);
}

console.log(`\nDone. To remove:`);
console.log(`  schtasks /Delete /TN ${TASK_NAME} /F`);
console.log(`  schtasks /Delete /TN ${startupTask} /F`);
console.log(`\nTo start now without rebooting:  npm start`);
