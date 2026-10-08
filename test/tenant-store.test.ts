import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { KeyVault } from '../src/encryption.js';
import { TenantStore } from '../src/tenant-store.js';

test(
  'Postgres isolates tenants, enforces admin writes, and persists encrypted keys across instances',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const vault = new KeyVault('v1', { v1: randomBytes(32).toString('base64') });
    const store = new TenantStore(pool, vault);
    const a = randomUUID(),
      b = randomUUID();
    const issuer = `https://issuer.example/${randomUUID()}`;
    const adminA = { issuer, subject: 'alice', clientId: 'gemini-a' };
    const memberA = { issuer, subject: 'member', clientId: 'gemini-a' };
    const adminB = { issuer, subject: 'bob', clientId: 'gemini-b' };
    try {
      await Promise.all([store.migrate(), new TenantStore(pool, vault).migrate()]);
      await pool.query('INSERT INTO tenants(id, name) VALUES ($1, $2), ($3, $4)', [
        a,
        'Org A',
        b,
        'Org B',
      ]);
      await pool.query(
        'INSERT INTO tenant_clients(issuer, client_id, tenant_id) VALUES ($1, $2, $3), ($1, $4, $5)',
        [issuer, 'gemini-a', a, 'gemini-b', b],
      );
      await pool.query(
        "INSERT INTO tenant_memberships(tenant_id, issuer, subject, role) VALUES ($1, $2, 'alice', 'admin'), ($1, $2, 'member', 'member'), ($3, $2, 'bob', 'admin')",
        [a, issuer, b],
      );
      assert.equal(await store.setKey(memberA, 'unauthorized'), false);
      assert.equal(await store.setKey({ ...adminA, clientId: 'gemini-b' }, 'unauthorized'), false);
      assert.equal(await store.setKey(adminA, 'secret-a'), true);
      assert.equal(await store.setKey(adminB, 'secret-b'), true);
      const second = new TenantStore(pool, vault);
      assert.equal(await second.keyFor(memberA), 'secret-a');
      assert.equal(await second.keyFor(adminB), 'secret-b');
      assert.equal(await second.keyFor({ ...adminA, clientId: 'gemini-b' }), undefined);
      assert.equal(await second.keyFor({ ...adminA, issuer: 'https://wrong.example' }), undefined);
      const rows = await pool.query('SELECT sealed FROM tenant_keys WHERE tenant_id IN ($1, $2)', [
        a,
        b,
      ]);
      assert.ok(!JSON.stringify(rows.rows).includes('secret-a'));
      assert.ok(!JSON.stringify(rows.rows).includes('secret-b'));
      await pool.query(
        'UPDATE tenant_memberships SET enabled = false WHERE tenant_id = $1 AND subject = $2',
        [a, 'member'],
      );
      assert.equal(await second.keyFor(memberA), undefined);
      await pool.query('UPDATE tenants SET enabled = false WHERE id = $1', [b]);
      assert.equal(await second.keyFor(adminB), undefined);
      assert.equal(await second.setKey(adminB, 'replacement'), false);
    } finally {
      await pool.query('DELETE FROM tenants WHERE id IN ($1, $2)', [a, b]);
      await pool.end();
    }
  },
);
