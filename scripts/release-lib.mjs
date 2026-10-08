// Adapted from blen-labs/fedreg-mcp-server (Apache-2.0); see NOTICE.
export const conventional =
  /^(feat|fix|docs|chore|ci|test|refactor|perf|build|style|revert)(\([\w./-]+\))?!?: .+/;
export function isRelease(subject) {
  return /^chore\(release\): v\d+\.\d+\.\d+$/.test(subject);
}
export function computeBump(commits) {
  let bump = 'patch';
  for (const { subject, body = '' } of commits) {
    if (!conventional.test(subject)) throw new Error('Non-conventional commit subject.');
    if (/^[a-z]+(?:\([\w./-]+\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:\s*\S/m.test(body))
      bump = 'major';
    if (bump !== 'major' && /^feat(?:\([\w./-]+\))?:/.test(subject)) bump = 'minor';
  }
  return bump;
}
export function validateVersion(version) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version.split('.').some((v) => !Number.isSafeInteger(Number(v)))
  )
    throw new Error('Expected a stable SemVer version.');
  return version;
}
export function bumpVersion(version, bump) {
  const parts = validateVersion(version).split('.').map(Number);
  const at = { major: 0, minor: 1, patch: 2 }[bump];
  if (at === undefined) throw new Error('Invalid version increment.');
  parts[at]++;
  for (let i = at + 1; i < 3; i++) parts[i] = 0;
  return validateVersion(parts.join('.'));
}
export function renderNotes(commits) {
  return (
    commits
      .map(({ subject, body = '' }) =>
        `- ${subject.replace(/[<>]/g, '')} ${/^BREAKING[ -]CHANGE:/m.test(body) ? '**Breaking change.**' : ''}`.trim(),
      )
      .join('\n') + '\n'
  );
}
export function insertSection(changelog, version, date, notes) {
  validateVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid release date.');
  if (!/^## \[Unreleased\]$/m.test(changelog) || changelog.includes(`## [${version}]`))
    throw new Error('Missing Unreleased section or duplicate release.');
  return changelog.replace(
    /^## \[Unreleased\]$/m,
    `## [Unreleased]\n\n## [${version}] - ${date}\n\n${notes.trimEnd()}`,
  );
}
