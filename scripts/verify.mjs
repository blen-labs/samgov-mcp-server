import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sourceFingerprint } from './source-fingerprint.mjs';

const suffix=randomBytes(6).toString('hex');
const network=`samgov-verify-${suffix}`, database=`samgov-pg-${suffix}`;
const password=randomBytes(24).toString('base64url');
const env={...process.env,POSTGRES_PASSWORD:password,TEST_DATABASE_URL:`postgresql://postgres:${password}@postgres:5432/postgres`};
const run=(args,quiet=false)=>execFileSync('docker',args,{env,stdio:quiet?'pipe':'inherit'});
let networkCreated=false,dbCreated=false;
const before = sourceFingerprint();
try {
  run(['network','create',network],true);networkCreated=true;
  run(['run','-d','--rm','--name',database,'--network',network,'--network-alias','postgres','-e','POSTGRES_PASSWORD','postgres:17-alpine'],true);dbCreated=true;
  let ready=false;
  for(let i=0;i<100;i++) {
    if(spawnSync('docker',['exec',database,'pg_isready','-U','postgres'],{stdio:'ignore'}).status===0){ready=true;break;}
    await new Promise(r=>setTimeout(r,200));
  }
  if(!ready) throw new Error('Test PostgreSQL did not become ready.');
  run(['build','--target','acceptance','-t','samgov-mcp-server:acceptance','.']);
  run(['run','--rm','--network',network,'-e','TEST_DATABASE_URL','samgov-mcp-server:acceptance']);
  const hashes=sourceFingerprint();
  if (JSON.stringify(before) !== JSON.stringify(hashes)) throw new Error('Sources changed during verification; rerun against the final files.');
  mkdirSync('.local',{recursive:true});
  writeFileSync('.local/verification.json',JSON.stringify({verifiedAt:new Date().toISOString(),result:'PASS',runtime:'Docker node:24-alpine',database:'Docker postgres:17-alpine',upstreamIdentity:'real Better Auth password setup and sessions using disposable test accounts',samApi:'mocked in automated suite; separate live acceptance required',files:hashes},null,2)+'\n',{mode:0o600});
  console.log('Container acceptance passed. Source fingerprints saved in .local/verification.json. Live Gemini and SAM.gov acceptance remain separate gates.');
} catch(e) {
  mkdirSync('.local',{recursive:true});
  writeFileSync('.local/verification.json',JSON.stringify({verifiedAt:new Date().toISOString(),result:'FAIL'})+'\n',{mode:0o600});
  console.error('Acceptance verification failed.');process.exitCode=1;
} finally {
  if(dbCreated)try{run(['stop',database],true);}catch{}
  if(networkCreated)try{run(['network','rm',network],true);}catch{}
}
