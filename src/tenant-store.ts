import type { Pool } from 'pg';
import { KeyVault, type SealedKey } from './encryption.js';

export type Principal = { issuer: string; subject: string; clientId: string };

export class TenantStore {
  constructor(private readonly pool: Pool, private readonly vault: KeyVault) {}

  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(739281056)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS tenants (
          id uuid PRIMARY KEY,
          name text NOT NULL,
          enabled boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS tenant_keys (
          tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
          sealed jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS tenant_clients (
          issuer text NOT NULL,
          client_id text NOT NULL,
          tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          PRIMARY KEY (issuer, client_id)
        );
        CREATE TABLE IF NOT EXISTS tenant_memberships (
          tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          issuer text NOT NULL,
          subject text NOT NULL,
          role text NOT NULL CHECK (role IN ('admin', 'member')),
          enabled boolean NOT NULL DEFAULT true,
          PRIMARY KEY (tenant_id, issuer, subject)
        );
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async resolve(principal: Principal): Promise<{ tenantId: string; role: 'admin' | 'member' } | undefined> {
    const result = await this.pool.query<{ tenant_id: string; role: 'admin' | 'member' }>(`
      SELECT t.id AS tenant_id, m.role FROM tenant_clients c
      JOIN tenants t ON t.id = c.tenant_id
      JOIN tenant_memberships m ON m.tenant_id = t.id AND m.issuer = c.issuer
      WHERE c.issuer = $1 AND c.client_id = $2 AND m.subject = $3
        AND t.enabled AND m.enabled`, [principal.issuer, principal.clientId, principal.subject]);
    const row = result.rows[0];
    return row ? { tenantId: row.tenant_id, role: row.role } : undefined;
  }

  async keyFor(principal: Principal): Promise<string | undefined> {
    // Membership and credential selection are one query, never a caller-provided tenant ID.
    const result = await this.pool.query<{ tenant_id: string; sealed: SealedKey }>(`
      SELECT t.id AS tenant_id, k.sealed FROM tenant_clients c
      JOIN tenants t ON t.id = c.tenant_id
      JOIN tenant_memberships m ON m.tenant_id = t.id AND m.issuer = c.issuer
      JOIN tenant_keys k ON k.tenant_id = t.id
      WHERE c.issuer = $1 AND c.client_id = $2 AND m.subject = $3
        AND t.enabled AND m.enabled`, [principal.issuer, principal.clientId, principal.subject]);
    const row = result.rows[0];
    return row ? this.vault.open(row.tenant_id, row.sealed) : undefined;
  }

  async setKey(principal: Principal, key: string): Promise<boolean> {
    const membership = await this.resolve(principal);
    if (!membership || membership.role !== 'admin') return false;
    const sealed = this.vault.seal(membership.tenantId, key);
    // Recheck admin authorization in the write statement to avoid stale authorization.
    const result = await this.pool.query(`
      INSERT INTO tenant_keys (tenant_id, sealed)
      SELECT t.id, $4::jsonb FROM tenant_clients c
      JOIN tenants t ON t.id = c.tenant_id
      JOIN tenant_memberships m ON m.tenant_id = t.id AND m.issuer = c.issuer
      WHERE c.issuer = $1 AND c.client_id = $2 AND m.subject = $3
        AND t.id = $5 AND t.enabled AND m.enabled AND m.role = 'admin'
      ON CONFLICT (tenant_id) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()`,
    [principal.issuer, principal.clientId, principal.subject, JSON.stringify(sealed), membership.tenantId]);
    return result.rowCount === 1;
  }
}
