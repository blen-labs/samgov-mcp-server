import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const paths = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const forbidden = paths.filter(
  (path) =>
    /(^|\/)(\.local|\.release|node_modules|dist|data|coverage)(\/|$)/.test(path) ||
    (/(^|\/)\.env(?:\.|$)/.test(path) && path !== '.env.example') ||
    /\.(pem|key|p12|pfx|dump|log)$/i.test(path),
);
if (forbidden.length)
  throw new Error(`Private/generated files in public source: ${forbidden.join(', ')}`);
for (const path of paths) {
  const body = readFileSync(path, 'utf8');
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(body) ||
    /\bGOCSPX-[A-Za-z0-9_-]{15,}/.test(body) ||
    /\bgh[pousr]_[A-Za-z0-9]{30,}/.test(body)
  )
    throw new Error(`Credential pattern detected in ${path}; values suppressed.`);
}
console.log(`${paths.length} public source files checked. Gitleaks is a separate CI gate.`);
