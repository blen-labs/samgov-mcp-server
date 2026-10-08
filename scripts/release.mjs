import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  bumpVersion,
  computeBump,
  insertSection,
  isRelease,
  renderNotes,
  validateVersion,
} from './release-lib.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`${key}=${value}`);
}
try {
  if (git('status', '--porcelain')) throw new Error('Release requires a clean checkout.');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const current = validateVersion(pkg.version);
  if (
    lock.version !== current ||
    lock.packages[''].version !== current ||
    !readFileSync('src/version.ts', 'utf8').includes(`'${current}'`)
  )
    throw new Error('Package, lockfile, and runtime version disagree.');
  const tags = git('tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-version:refname')
    .split('\n')
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  const previous = tags[0];
  if (previous && previous !== `v${current}`)
    throw new Error('Latest reachable tag does not match the package version.');
  const shas = git('log', '--no-merges', '--format=%H', previous ? `${previous}..HEAD` : 'HEAD')
    .split('\n')
    .filter(Boolean);
  const commits = shas
    .map((sha) => {
      const [subject, body = ''] = git('show', '--no-patch', '--format=%s%x00%b', sha).split('\0');
      return { subject, body };
    })
    .filter((c) => !isRelease(c.subject));
  if (!commits.length) {
    output('released', 'false');
    process.exit(0);
  }
  const bump = computeBump(commits);
  const version = previous ? bumpVersion(current, bump) : current;
  // A tag outside this ancestry must not be overwritten or reused.
  if (git('tag', '--list', `v${version}`)) throw new Error('Release tag already exists.');
  const notes = renderNotes(commits);
  const changelog = insertSection(
    readFileSync('CHANGELOG.md', 'utf8'),
    version,
    new Date().toISOString().slice(0, 10),
    notes,
  );
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
  writeFileSync(
    'src/version.ts',
    `// Stamped with package.json and package-lock.json by the release script.\nexport const VERSION = '${version}';\n`,
  );
  writeFileSync('CHANGELOG.md', changelog);
  mkdirSync('.release', { recursive: true });
  writeFileSync('.release/notes.md', notes);
  output('released', 'true');
  output('version', version);
  output('notes_file', '.release/notes.md');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
