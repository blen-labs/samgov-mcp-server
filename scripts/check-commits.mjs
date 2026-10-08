import { execFileSync } from 'node:child_process';
import { conventional, isRelease } from './release-lib.mjs';
const base = process.env.COMMIT_BASE;
const args = [
  'log',
  '--no-merges',
  '--format=%s',
  base && /^[0-9a-f]{40}$/.test(base) && !/^0+$/.test(base) ? `${base}..HEAD` : 'HEAD',
];
const subjects = execFileSync('git', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
if (subjects.some((s) => !conventional.test(s) && !isRelease(s))) {
  console.error('Use Conventional Commits: type(scope): description.');
  process.exitCode = 1;
} else console.log(`${subjects.length} commit subjects conform.`);
