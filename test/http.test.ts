import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { requestListener } from '../src/http.js';

test('malformed targets and synchronous handler exceptions cannot crash the HTTP server', async () => {
  const server = createServer(
    requestListener('https://service.example', (req, res) => {
      if (req.url === '/explode') throw new Error('private-database-detail');
      res.end('healthy');
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const send = (path: string, host = 'service.example') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    for (const path of ['http://[', '//attacker.example/mcp', 'http://attacker.example/mcp'])
      assert.equal((await send(path)).status, 400);
    const failed = await send('/explode');
    assert.equal(failed.status, 500);
    assert.ok(!failed.body.includes('private-database-detail'));
    assert.equal((await send('/healthz', 'attacker.example')).status, 403);
    assert.equal((await send('/healthz')).body, 'healthy');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
