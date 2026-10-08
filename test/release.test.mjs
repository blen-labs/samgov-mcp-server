import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { bumpVersion, computeBump, insertSection } from '../scripts/release-lib.mjs';

test('release policy: breaking > features > patch, invalid versions fail closed', () => {
  assert.equal(computeBump([{ subject: 'fix: repair' }, { subject: 'feat: add' }]), 'minor');
  assert.equal(computeBump([{ subject: 'docs: update' }]), 'patch');
  assert.equal(computeBump([{ subject: 'feat!: change' }]), 'major');
  assert.equal(computeBump([{ subject: 'fix: change', body: 'BREAKING-CHANGE: schema' }]), 'major');
  assert.throws(() => computeBump([{ subject: 'oops' }]));
  assert.throws(() => computeBump([{ subject: 'feat!: change' }, { subject: 'oops' }]));
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  for (const v of ['1.2', '1.2.3; bad', '01.2.3', '1.2.3-beta'])
    assert.throws(() => bumpVersion(v, 'patch'));
  assert.throws(() => insertSection('# Changelog', '1.0.0', '2026-10-08', 'notes'));
});

test('release preparation handles first release, reruns, version synchronization, and docs-only changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'samgov-release-test-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  const run = () =>
    spawnSync(process.execPath, ['scripts/release.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '' },
    });
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'scripts'));
    cpSync(resolve('scripts/release.mjs'), join(dir, 'scripts/release.mjs'));
    cpSync(resolve('scripts/release-lib.mjs'), join(dir, 'scripts/release-lib.mjs'));
    cpSync(resolve('scripts/recover-release.mjs'), join(dir, 'scripts/recover-release.mjs'));
    writeFileSync(join(dir, '.gitignore'), '.release/\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test', version: '0.1.0' }));
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } }),
    );
    writeFileSync(join(dir, 'src/version.ts'), "export const VERSION = '0.1.0';\n");
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n');
    git('init', '-b', 'main');
    git('config', 'user.name', 'Release test');
    git('config', 'user.email', 'test@example.com');
    git('add', '.');
    git('commit', '-m', 'feat: initial service');
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /version=0.1.0/);
    assert.equal(git('tag'), '', 'Preparing must never tag or push');
    assert.notEqual(run().status, 0, 'Uncommitted preparation cannot be repeated');
    git('add', '.');
    git('commit', '-m', 'chore(release): v0.1.0');
    git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
    assert.match(run().stdout, /released=false/);
    const recover = (tag) =>
      spawnSync(process.execPath, ['scripts/recover-release.mjs', tag], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: '' },
      });
    assert.equal(recover('v0.1.0').status, 0);
    assert.match(readFileSync(join(dir, '.release/notes.md'), 'utf8'), /feat: initial service/);
    assert.notEqual(recover('v0.1.0;invalid').status, 0);
    writeFileSync(join(dir, 'README.md'), 'Documentation change\n');
    git('add', '.');
    git('commit', '-m', 'docs: clarify setup');
    assert.notEqual(recover('v0.1.0').status, 0, 'Recovery must reject a checkout past the tag');
    r = run();
    assert.equal(r.status, 0, r.stderr);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'))),
      lock = JSON.parse(readFileSync(join(dir, 'package-lock.json')));
    assert.equal(pkg.version, '0.1.1');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.match(readFileSync(join(dir, 'src/version.ts'), 'utf8'), /'0.1.1'/);
    assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /docs: clarify setup/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configuration generator creates private secrets and never overwrites an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'samgov-config-test-')),
    path = join(dir, 'new.env');
  try {
    const run = (origin = 'https://service.example') =>
      spawnSync(process.execPath, ['scripts/init-env.mjs', origin, path], {
        encoding: 'utf8',
      });
    assert.notEqual(run("https://unsafe'host.example").status, 0);
    const first = run();
    assert.equal(first.status, 0);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const before = readFileSync(path, 'utf8');
    assert.match(before, /BETTER_AUTH_SECRET=/);
    assert.match(before, /OAUTH_SIGNING_JWKS=/);
    const second = run();
    assert.notEqual(second.status, 0);
    assert.equal(readFileSync(path, 'utf8'), before);
    for (const [, value] of before.matchAll(/='([^']+)'/g)) {
      if (value.length > 32)
        assert.ok(!(first.stdout + first.stderr + second.stdout + second.stderr).includes(value));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
