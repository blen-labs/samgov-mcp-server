import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { errors, type Adapter, type AdapterPayload } from 'oidc-provider';
import { KeyVault, type SealedKey } from './encryption.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class OAuthStore {
  constructor(readonly pool: Pool, private readonly vault: KeyVault) {}

  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(739281057)');
      await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_records (
        model text NOT NULL, id text NOT NULL, sealed jsonb NOT NULL,
        grant_id text, uid text, user_code text, consumed bigint, client_id text, account_id text,
        expires_at timestamptz, PRIMARY KEY(model,id)
      );
      ALTER TABLE oauth_records ADD COLUMN IF NOT EXISTS client_id text;
      ALTER TABLE oauth_records ADD COLUMN IF NOT EXISTS account_id text;
      CREATE INDEX IF NOT EXISTS oauth_grants ON oauth_records(grant_id);
      CREATE INDEX IF NOT EXISTS oauth_clients ON oauth_records(client_id,account_id);
      CREATE INDEX IF NOT EXISTS oauth_uids ON oauth_records(model,uid);
      CREATE TABLE IF NOT EXISTS accounts (
        id uuid PRIMARY KEY, upstream_issuer text NOT NULL, upstream_subject text NOT NULL,
        email text NOT NULL, enabled boolean NOT NULL DEFAULT true,
        UNIQUE(upstream_issuer,upstream_subject)
      );
      CREATE TABLE IF NOT EXISTS tenant_invites (
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email text NOT NULL, role text NOT NULL CHECK(role IN ('admin','member')),
        PRIMARY KEY(tenant_id,email)
      );
      CREATE TABLE IF NOT EXISTS rate_windows (
        bucket text PRIMARY KEY, count integer NOT NULL, resets_at timestamptz NOT NULL
      );
      `);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  adapter(model: string): Adapter {
    const store = this;
    const load = async (column: 'id' | 'uid' | 'user_code', value: string) => {
      const result = await store.pool.query<{ id: string; sealed: SealedKey; consumed: string | null }>(
        `SELECT id,sealed,consumed FROM oauth_records WHERE model=$1 AND ${column}=$2 AND (expires_at IS NULL OR expires_at>now())`, [model, column === 'id' ? digest(value) : value]);
      const row = result.rows[0];
      if (!row) return;
      const payload = JSON.parse(store.vault.open(`oauth:${model}:${row.id}`, row.sealed));
      if (row.consumed) payload.consumed = Number(row.consumed);
      return payload as AdapterPayload;
    };
    return {
      async upsert(id, payload, expiresIn) {
        const hashed = digest(id);
        const sealed = store.vault.seal(`oauth:${model}:${hashed}`, JSON.stringify(payload));
        await store.pool.query(`INSERT INTO oauth_records(model,id,sealed,grant_id,uid,user_code,expires_at,client_id,account_id)
          VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::integer IS NULL THEN NULL ELSE now()+$7*interval '1 second' END,$8,$9)
          ON CONFLICT(model,id) DO UPDATE SET sealed=EXCLUDED.sealed,grant_id=EXCLUDED.grant_id,uid=EXCLUDED.uid,user_code=EXCLUDED.user_code,expires_at=EXCLUDED.expires_at,client_id=EXCLUDED.client_id,account_id=EXCLUDED.account_id`,
        [model, hashed, JSON.stringify(sealed), payload.grantId ?? null, payload.uid ?? null, payload.userCode ?? null, expiresIn ?? null,payload.clientId ?? payload.client_id ?? null,payload.accountId ?? null]);
      },
      find: id => load('id', id), findByUid: uid => load('uid', uid), findByUserCode: code => load('user_code', code),
      async consume(id) {
        const result = await store.pool.query(`UPDATE oauth_records SET consumed=extract(epoch from now())::bigint WHERE model=$1 AND id=$2 AND consumed IS NULL AND (expires_at IS NULL OR expires_at>now())`, [model, digest(id)]);
        if (result.rowCount !== 1) {
          const reused=await store.pool.query<{grant_id:string}>('SELECT grant_id FROM oauth_records WHERE model=$1 AND id=$2',[model,digest(id)]);
          if(reused.rows[0]?.grant_id) await store.adapter(model).revokeByGrantId(reused.rows[0].grant_id);
          throw new errors.InvalidGrant('Grant has expired or was already consumed.');
        }
      },
      async destroy(id) { await store.pool.query('DELETE FROM oauth_records WHERE model=$1 AND id=$2', [model, digest(id)]); },
      async revokeByGrantId(grantId) { await store.pool.query('DELETE FROM oauth_records WHERE grant_id=$1 OR (model=$2 AND id=$3)', [grantId, 'Grant', digest(grantId)]); },
    };
  }

  async put(model: string, id: string, value: Record<string, unknown>, ttl = 600) {
    await this.adapter(model).upsert(id, value as AdapterPayload, ttl);
  }
  async get<T>(model: string, id: string): Promise<T | undefined> {
    return await this.adapter(model).find(id) as T | undefined;
  }
  async take<T>(model: string, id: string): Promise<T | undefined> {
    const result = await this.pool.query<{sealed: SealedKey}>(`DELETE FROM oauth_records WHERE model=$1 AND id=$2 AND (expires_at IS NULL OR expires_at>now()) RETURNING sealed`, [model, digest(id)]);
    const row = result.rows[0];
    return row ? JSON.parse(this.vault.open(`oauth:${model}:${digest(id)}`, row.sealed)) as T : undefined;
  }

  async bindIdentity(issuer: string, clientId: string, identity: { issuer: string; subject: string; email: string; verified: boolean }): Promise<string | undefined> {
    if (!identity.verified) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const invite = await client.query<{tenant_id: string; role: 'admin'|'member'}>(`SELECT i.tenant_id,i.role FROM tenant_invites i JOIN tenant_clients c ON c.tenant_id=i.tenant_id JOIN tenants t ON t.id=i.tenant_id WHERE c.issuer=$1 AND c.client_id=$2 AND i.email=$3 AND t.enabled FOR UPDATE OF i`, [issuer, clientId, identity.email.toLowerCase()]);
      const existing = await client.query<{id: string; enabled: boolean}>('SELECT id,enabled FROM accounts WHERE upstream_issuer=$1 AND upstream_subject=$2', [identity.issuer, identity.subject]);
      if (existing.rows[0]?.enabled === false) { await client.query('ROLLBACK'); return; }
      let accountId = existing.rows[0]?.id ?? randomUUID();
      if (invite.rows[0]) {
        const account = await client.query<{id:string;enabled:boolean}>(`INSERT INTO accounts(id,upstream_issuer,upstream_subject,email) VALUES($1,$2,$3,$4) ON CONFLICT(upstream_issuer,upstream_subject) DO UPDATE SET email=EXCLUDED.email RETURNING id,enabled`, [accountId, identity.issuer, identity.subject, identity.email.toLowerCase()]);
        if (!account.rows[0]?.enabled) { await client.query('ROLLBACK'); return; }
        accountId=account.rows[0].id;
        await client.query(`INSERT INTO tenant_memberships(tenant_id,issuer,subject,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [invite.rows[0].tenant_id, issuer, accountId, invite.rows[0].role]);
        await client.query('DELETE FROM tenant_invites WHERE tenant_id=$1 AND email=$2', [invite.rows[0].tenant_id, identity.email.toLowerCase()]);
      }
      const membership = await client.query(`SELECT 1 FROM tenant_memberships m JOIN tenant_clients c ON c.tenant_id=m.tenant_id AND c.issuer=m.issuer JOIN tenants t ON t.id=m.tenant_id WHERE c.issuer=$1 AND c.client_id=$2 AND m.subject=$3 AND m.enabled AND t.enabled`, [issuer, clientId, accountId]);
      await client.query('COMMIT');
      return membership.rowCount ? accountId : undefined;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  async allow(bucket: string, max: number, seconds: number): Promise<boolean> {
    const result = await this.pool.query<{count:number}>(`INSERT INTO rate_windows(bucket,count,resets_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN rate_windows.resets_at<=now() THEN 1 ELSE LEAST(rate_windows.count+1,$3::integer+1) END,
      resets_at=CASE WHEN rate_windows.resets_at<=now() THEN now()+$2*interval '1 second' ELSE rate_windows.resets_at END RETURNING count`, [digest(bucket), seconds,max]);
    return result.rows[0]!.count <= max;
  }

  async revokeTenant(tenantId: string, accountId?: string) {
    await this.pool.query(`DELETE FROM oauth_records WHERE model<>'Client' AND client_id IN (SELECT client_id FROM tenant_clients WHERE tenant_id=$1)
      AND ($2::text IS NULL OR account_id=$2)`,[tenantId,accountId??null]);
  }

  async cleanup() {
    await this.pool.query('DELETE FROM oauth_records WHERE expires_at<now()');
    await this.pool.query('DELETE FROM rate_windows WHERE resets_at<now()');
  }
}
