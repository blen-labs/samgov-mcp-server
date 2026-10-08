import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Requires an Inspector OAuth grant obtained through the real browser flow.
// Never reads the SAM.gov key: every search goes through the deployed MCP.
process.umask(0o077);
mkdirSync('.local', { recursive: true });
const evidence = { verifiedAt: new Date().toISOString(), result: 'FAIL', checks: [] };
const format = date => `${String(date.getUTCMonth()+1).padStart(2,'0')}/${String(date.getUTCDate()).padStart(2,'0')}/${date.getUTCFullYear()}`;
const end = new Date(), start = new Date(end); start.setUTCDate(start.getUTCDate()-7);
const input = { posted_from: process.env.SAM_TEST_POSTED_FROM || format(start), posted_to: process.env.SAM_TEST_POSTED_TO || format(end), limit: 2 };
function inspect(name, method, args, era = 'modern') {
  const output = resolve(`.local/inspector-${name}.json`);
  const flags = ['scripts/inspector.mjs', '--cli', '--protocol-era', era, '--method', method, '--format', 'json', '--quiet', '--output', output];
  if (args) flags.push('--tool-name', 'get_sam_opportunities', '--tool-args-json', JSON.stringify(args));
  // Remove any stale evidence before a failed command can be mistaken for success.
  writeFileSync(output, 'null\n', { mode: 0o600 });
  const run = spawnSync(process.execPath, flags, { encoding: 'utf8', stdio: 'pipe', timeout: 45000 });
  assert.ok([0, 5].includes(run.status), 'Inspector connection/command failed; re-authenticate in its UI.');
  const value = JSON.parse(readFileSync(output));
  assert.ok(value, 'Inspector did not produce a result.');
  assert.equal(run.status === 5, value.isError === true, 'Tool failure must have a nonzero exit status.');
  return value;
}
function successfulSearch(name, args) {
  const value = inspect(name, 'tools/call', args);
  if (value.isError) {
    // Only persist our bounded, sanitized server error code; never arbitrary output.
    let code; try { code = JSON.parse(value.content?.[0]?.text).code; } catch {}
    evidence.searchError = /^[A-Z_]{1,40}$/.test(code) ? code : 'TOOL_ERROR';
    throw new Error('Live SAM.gov search failed; inspect the saved tool result.');
  }
  const result = value.structuredContent;
  assert.ok(Array.isArray(result?.opportunities));
  return result;
}
try {
  const config = JSON.parse(readFileSync(process.env.SAM_INSPECTOR_CONFIG || '.local/inspector/config.json'));
  const endpoint = config.mcpServers['samgov-production'].url;
  evidence.endpoint = endpoint;
  const denied = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}), signal: AbortSignal.timeout(15000) });
  assert.equal(denied.status, 401); evidence.checks.push('Unauthenticated MCP rejected');
  for (const era of ['modern', 'legacy']) {
    const info = inspect(`${era}-discovery`, 'initialize', undefined, era);
    assert.equal(info.capabilities.tools.listChanged, false);
    const list = inspect(`${era}-tools`, 'tools/list', undefined, era);
    assert.deepEqual(list.tools.map(t => t.name), ['get_sam_opportunities']);
    assert.ok(!JSON.stringify(list.tools).includes('api_key'));
    evidence.checks.push(`${era}: discovery, fixed tool list, no notification subscriptions`);
  }
  const invalid = inspect('invalid-input', 'tools/call', { ...input, posted_from:'10/08/2026', posted_to:'10/01/2026' });
  assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /Date range must be ordered/);
  evidence.checks.push('Invalid date range rejected');
  const first = successfulSearch('search', input);
  assert.ok(first.opportunities.length > 0 && first.next_offset !== null, 'Need multiple real notices to verify search and pagination.');
  const second = successfulSearch('page-two', { ...input, offset:first.next_offset });
  const ids = new Set(first.opportunities.map(n => n.noticeId));
  assert.ok(second.opportunities.length > 0 && second.opportunities.every(n => !ids.has(n.noticeId)));
  const id = first.opportunities[0].noticeId;
  const detail = successfulSearch('notice', { ...input, notice_id:id, limit:1 });
  assert.equal(detail.opportunities[0]?.noticeId, id);
  evidence.checks.push('Live search, distinct second page, exact notice-ID lookup');
  evidence.result = 'PASS';
} catch {
  evidence.limitation = 'Acceptance incomplete. Review sanitized Inspector result files; no successful search is inferred from authentication or discovery.';
  process.exitCode = 1;
} finally {
  writeFileSync('.local/inspector-acceptance.json', JSON.stringify(evidence, null, 2)+'\n', {mode:0o600});
  console.log(JSON.stringify(evidence, null, 2));
}
