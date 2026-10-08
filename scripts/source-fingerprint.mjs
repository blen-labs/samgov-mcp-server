import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

export function sourceFingerprint() {
  const files = ['package.json', 'package-lock.json', 'Dockerfile', 'tsconfig.json', 'tsconfig.test.json', 'biome.json', '.prettierrc.json'];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error('Verification inputs must not contain symlinks.');
    }
  }
  for (const dir of ['src', 'test', 'scripts', '.github']) walk(dir);
  return Object.fromEntries(files.filter(existsSync).sort().map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
}
