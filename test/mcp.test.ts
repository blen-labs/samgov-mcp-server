import assert from 'node:assert/strict';
import test from 'node:test';
import { createSamMcp } from '../src/mcp.js';

function request(method: string, params: Record<string, unknown> = {}, modern = true) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (modern) {
    headers['MCP-Protocol-Version'] = '2026-07-28';
    headers['Mcp-Method'] = method;
    if (params.name) headers['Mcp-Name'] = String(params.name);
    params = { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } };
  }
  return new Request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

test('modern client discovers and calls tools without initialization or a session', async () => {
  const mcp = createSamMcp('test-key', async () => Response.json({ totalRecords: 0, opportunitiesData: [] }));
  try {
    for (const method of ['server/discover', 'tools/list']) {
      const response = await mcp.fetch(request(method));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('mcp-session-id'), null);
      const body = await response.json();
      assert.ok(body.result, JSON.stringify(body));
      if (method === 'server/discover') assert.equal(body.result.capabilities.tools.listChanged, false, 'Finite stateless service must not advertise subscriptions');
      if (method === 'tools/list') {
        assert.equal(body.result.tools.length, 1);
        assert.ok(!JSON.stringify(body.result.tools).includes('api_key'));
      }
    }
    const response = await mcp.fetch(request('tools/call', { name: 'get_sam_opportunities', arguments: { posted_from: '10/01/2026', posted_to: '10/07/2026' } }));
    const body = await response.json();
    assert.equal(body.result.structuredContent.total, 0, JSON.stringify(body));
    assert.equal(body.result.isError, undefined);
  } finally { await mcp.close(); }
});

test('rejects protocol/header mismatch and does not support session endpoints', async () => {
  const mcp = createSamMcp('test-key');
  try {
    const req = request('tools/list');
    req.headers.set('Mcp-Method', 'tools/call');
    assert.equal((await mcp.fetch(req)).status, 400);
    for (const method of ['GET', 'DELETE']) assert.equal((await mcp.fetch(new Request('http://localhost/mcp', { method }))).status, 405);
  } finally { await mcp.close(); }
});

test('accepts legacy initialization without issuing a session', async () => {
  const mcp = createSamMcp('test-key');
  try {
    const response = await mcp.fetch(request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'legacy-test', version: '1' }, capabilities: {} }, false));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), null);
    const text = await response.text();
    const body = JSON.parse(/^data: (.+)$/m.exec(text)?.[1] ?? text);
    assert.equal(body.result.protocolVersion, '2025-11-25');
    assert.equal(body.result.capabilities.tools.listChanged, false);
  } finally { await mcp.close(); }
});
