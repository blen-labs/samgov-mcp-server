import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const url = new URL(process.env.DEPLOY_URL);
assert.equal(url.protocol, 'https:');
const expected = JSON.parse(readFileSync('package.json', 'utf8')).version;
const deadline = Date.now() + 120000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const health = await fetch(new URL('/healthz', url), {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const body = await health.json();
    if (health.status === 200 && body.status === 'ok' && body.version === expected) {
      ready = true;
      break;
    }
  } catch {}
  await setTimeout(2000);
}
assert.ok(
  ready,
  'Expected release version never became healthy; previous deployment health is not acceptance.',
);
const r = await fetch(new URL('/mcp', url), {
  redirect: 'error',
  signal: AbortSignal.timeout(15000),
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
assert.equal(r.status, 401);
assert.match(r.headers.get('www-authenticate') ?? '', /resource_metadata=/);
console.log(
  `Release ${expected} health and unauthenticated MCP rejection passed. Live search and client acceptance remain separate gates.`,
);
