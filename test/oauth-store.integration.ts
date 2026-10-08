import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {KeyVault} from '../src/encryption.js';
import {TenantStore} from '../src/tenant-store.js';
import {OAuthStore} from '../src/oauth-store.js';

test('durable OAuth storage encrypts secrets, expires records, atomically consumes grants, and revokes only the selected tenant',async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 const vault=new KeyVault('test',{test:randomBytes(32).toString('base64')});
 const store=new OAuthStore(pool,vault),replica=new OAuthStore(pool,vault);
 const a=randomUUID(),b=randomUUID(),clientA=randomUUID(),clientB=randomUUID();
 try{
  await new TenantStore(pool,vault).migrate();await Promise.all([store.migrate(),replica.migrate()]);
  await pool.query('INSERT INTO tenants(id,name)VALUES($1,$2),($3,$4)',[a,'Test A',b,'Test B']);
  await pool.query('INSERT INTO tenant_clients(issuer,client_id,tenant_id)VALUES($1,$2,$3),($1,$4,$5)',['https://test.example',clientA,a,clientB,b]);
  const code=randomUUID();await store.adapter('AuthorizationCode').upsert(code,{clientId:clientA,accountId:'account-a',grantId:'grant-a',client_secret:'synthetic-secret'},60);
  assert.equal((await replica.adapter('AuthorizationCode').find(code))?.client_secret,'synthetic-secret');
  const encrypted=await pool.query('SELECT sealed FROM oauth_records WHERE client_id=$1',[clientA]);
  assert.ok(!JSON.stringify(encrypted.rows).includes('synthetic-secret'));
  const race=await Promise.allSettled([store.adapter('AuthorizationCode').consume(code),replica.adapter('AuthorizationCode').consume(code)]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(race.filter(r=>r.status==='rejected').length,1);
  const expired=randomUUID();await store.put('State',expired,{secret:'expired'},0);assert.equal(await store.get('State',expired),undefined);
  const oneTime=randomUUID();await store.put('State',oneTime,{secret:'one-time'});
  const taken=await Promise.all([store.take('State',oneTime),replica.take('State',oneTime)]);
  assert.equal(taken.filter(Boolean).length,1);
  const tokenA=randomUUID(),tokenB=randomUUID();await store.adapter('AccessToken').upsert(tokenA,{clientId:clientA,accountId:'account-a'},60);await store.adapter('AccessToken').upsert(tokenB,{clientId:clientB,accountId:'account-b'},60);
  await store.revokeTenant(a);assert.equal(await store.adapter('AccessToken').find(tokenA),undefined);assert.ok(await store.adapter('AccessToken').find(tokenB));
 }finally{await pool.query('DELETE FROM tenants WHERE id IN($1,$2)',[a,b]);await pool.end();}
});
