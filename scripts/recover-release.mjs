import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { validateVersion } from './release-lib.mjs';
const tag = process.argv[2];
const version = validateVersion(tag?.slice(1));
if (tag !== `v${version}`) throw new Error('Invalid recovery tag.');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (
  git('rev-parse', 'HEAD') !== git('rev-parse', `refs/tags/${tag}^{commit}`) ||
  JSON.parse(readFileSync('package.json')).version !== version
)
  throw new Error('Recovery must use the exact existing release tag.');
const section = readFileSync('CHANGELOG.md', 'utf8')
  .split(`## [${version}] - `)[1]
  ?.split('\n## [')[0];
if (!section) throw new Error('Release notes missing.');
mkdirSync('.release', { recursive: true });
writeFileSync('.release/notes.md', section.split('\n').slice(1).join('\n').trim() + '\n');
for (const [k, v] of Object.entries({
  released: 'true',
  version,
  notes_file: '.release/notes.md',
})) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  console.log(`${k}=${v}`);
}
