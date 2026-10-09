import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { ADMIN_SCOPE, READ_SCOPE } from '../src/auth.js';

function setup() {
  const calls: string[] = [];
  const writes: string[] = [];
  const app = createApp({
    publicUrl: 'https://mcp.example',
    issuer: 'https://issuer.example',
    verify: async (token) => {
      if (token === 'invalid') throw new Error('secret');
      return {
        issuer: 'https://issuer.example',
        subject: token,
        clientId: 'gemini',
        scopes: token === 'noscope' ? [] : [READ_SCOPE, ADMIN_SCOPE],
      };
    },
    store: {
      resolve: async (p) =>
        ['admin', 'member'].includes(p.subject)
          ? { tenantId: 'org-a', role: p.subject === 'admin' ? 'admin' : 'member' }
          : undefined,
      keyRecord: async (p) =>
        ['alice', 'bob'].includes(p.subject)
          ? { key: `key-${p.subject}`, savedAt: new Date('2026-10-01T00:00:00Z') }
          : undefined,
      setKey: async (_p, key) => {
        writes.push(key);
        return true;
      },
    },
    fetcher: async (url) => {
      const key = new URL(String(url)).searchParams.get('api_key')!;
      calls.push(key);
      if (key === 'rejected-test-secret') return new Response(null, { status: 403 });
      return Response.json({ totalRecords: 0, opportunitiesData: [] });
    },
  });
  return { app, calls, writes };
}

function rpc(token: string) {
  return new Request('https://mcp.example/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'get_sam_opportunities',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_sam_opportunities',
        arguments: { posted_from: '10/01/2026', posted_to: '10/07/2026' },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
        },
      },
    }),
  });
}

test('authenticated requests use their resolved key and preserve structured MCP responses', async () => {
  const { app, calls } = setup();
  const responses = await Promise.all(['alice', 'bob'].map((token) => app.fetch(rpc(token))));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), null);
    assert.equal((await response.json()).result.structuredContent.total, 0);
  }
  assert.deepEqual(calls.sort(), ['key-alice', 'key-bob']);
});

test('auth, scope, tenant membership, and browser Origin fail closed before SAM.gov', async () => {
  const { app, calls } = setup();
  const invalid = await app.fetch(rpc('invalid'));
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
  assert.equal((await app.fetch(rpc('noscope'))).status, 403);
  assert.equal((await app.fetch(rpc('outsider'))).status, 403);
  const crossOrigin = rpc('alice');
  crossOrigin.headers.set('Origin', 'https://attacker.example');
  assert.equal((await app.fetch(crossOrigin)).status, 403);
  assert.deepEqual(calls, []);
});

test('admin credential endpoint requires scope and role and never echoes credentials', async () => {
  const { app, writes } = setup();
  const save = (token: string, body: unknown) =>
    app.fetch(
      new Request('https://mcp.example/admin/credential', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  assert.equal((await save('member', { api_key: 'new-test-secret' })).status, 403);
  assert.equal(
    (await save('admin', { api_key: 'new-test-secret', tenant_id: 'other' })).status,
    400,
  );
  const rejected = await save('admin', { api_key: 'rejected-test-secret' });
  assert.equal(rejected.status, 422);
  assert.ok(!JSON.stringify(await rejected.json()).includes('rejected-test-secret'));
  const response = await save('admin', { api_key: 'new-test-secret' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { saved: true, upstream_verified: true });
  assert.deepEqual(writes, ['new-test-secret']);
});

test('health identifies the deployed runtime version without exposing configuration', async () => {
  const { app } = setup();
  const body = await (await app.fetch(new Request('https://mcp.example/healthz'))).json();
  assert.equal(body.status, 'ok');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(body).sort(), ['status', 'version']);
});

test('tool-call safeguards refuse before SAM.gov with a readable tool error', async () => {
  const seen: unknown[] = [];
  let fetched = 0;
  const app = createApp({
    publicUrl: 'https://mcp.example',
    issuer: 'https://issuer.example',
    verify: async (token) => ({
      issuer: 'https://issuer.example',
      subject: token,
      clientId: 'gemini',
      scopes: [READ_SCOPE],
    }),
    store: {
      resolve: async () => ({ tenantId: 'org-a', role: 'member' }),
      keyRecord: async () => ({ key: 'key-alice', savedAt: new Date() }),
      setKey: async () => true,
    },
    fetcher: async () => (fetched++, Response.json({ totalRecords: 0, opportunitiesData: [] })),
    limitToolCall: async (_principal, call) => {
      seen.push(call);
      return { code: 'DAILY_LIMIT', message: 'Limit reached.', retry_after: '3600' };
    },
  });
  const response = await app.fetch(rpc('alice'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.deepEqual(JSON.parse(body.result.content[0].text), {
    code: 'DAILY_LIMIT',
    message: 'Limit reached.',
    retry_after: '3600',
  });
  assert.equal(fetched, 0, 'refused calls never reach SAM.gov');
  assert.equal((seen[0] as { name: string }).name, 'get_sam_opportunities');
});
