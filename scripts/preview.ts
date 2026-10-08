// Disposable local acceptance fixture. Never included in the production image.
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {generateKeyPair,exportJWK} from 'jose';
import pg from 'pg';
import {toNodeHandler} from '@modelcontextprotocol/node';
import {KeyVault} from '../src/encryption.js';
import {TenantStore} from '../src/tenant-store.js';
import {OAuthStore} from '../src/oauth-store.js';
import {createBroker} from '../src/oauth.js';
import {createLogin} from '../src/better-login.js';
import {createApp} from '../src/app.js';
import {READ_SCOPE} from '../src/auth.js';

if(!process.env.TEST_DATABASE_URL)throw new Error('An isolated TEST_DATABASE_URL is required.');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
const vault=new KeyVault('preview',{preview:randomBytes(32).toString('base64')});
const tenants=new TenantStore(pool,vault),store=new OAuthStore(pool,vault);
await tenants.migrate();await store.migrate();
const tenantId=randomUUID(),clientId=randomUUID(),accountId=randomUUID(),secret=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');
let route: Parameters<typeof createServer>[0];
const server=createServer((req,res)=>{void (route as Function)(req,res).catch(()=>{res.statusCode=500;res.end('Preview failed.');});});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
await pool.query('INSERT INTO tenants(id,name)VALUES($1,$2)',[tenantId,'Synthetic Organization — local test']);
await pool.query('INSERT INTO tenant_clients(issuer,client_id,tenant_id)VALUES($1,$2,$3)',[origin,clientId,tenantId]);
const login=createLogin(pool,origin,randomBytes(32).toString('base64url'));await login.migrate();
const email=`preview-${clientId}@example.com`;
const user=await login.auth.api.createUser({body:{email,name:'Preview Admin',password:'preview-password-1234'}});
await pool.query('INSERT INTO accounts(id,upstream_issuer,upstream_subject,email)VALUES($1,$2,$3,$4)',[accountId,`${origin}/account`,user.user.id,email]);
await pool.query("INSERT INTO tenant_memberships(tenant_id,issuer,subject,role)VALUES($1,$2,$3,'admin')",[tenantId,origin,accountId]);
await tenants.setKey({issuer:origin,subject:accountId,clientId},'synthetic-preview-sam-key');
await store.adapter('Client').upsert(clientId,{client_id:clientId,client_secret:secret,client_name:'Synthetic Gemini client',client_secret_expires_at:0,redirect_uris:[`${origin}/client-callback`],response_types:['code'],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'client_secret_post',application_type:'web',scope:`openid offline_access ${READ_SCOPE}`});
const {privateKey}=await generateKeyPair('RS256',{extractable:true});
const broker=createBroker({publicUrl:origin,store,tenants,jwks:{keys:[{...await exportJWK(privateKey),kid:'test',alg:'RS256',use:'sig'}]},cookieKeys:[randomBytes(32).toString('base64url')],allowLocalHttp:true,login});
const app=toNodeHandler(createApp({publicUrl:origin,issuer:origin,store:tenants,verify:broker.verify,fetcher:async()=>Response.json({totalRecords:1,opportunitiesData:[{noticeId:'a'.repeat(32),title:'Synthetic opportunity'}]})}));
const auth=`${origin}/oauth/authorize?${new URLSearchParams({client_id:clientId,redirect_uri:`${origin}/client-callback`,response_type:'code',scope:`openid offline_access ${READ_SCOPE}`,resource:`${origin}/mcp`,state:'preview-state',code_challenge:challenge,code_challenge_method:'S256',prompt:'consent'})}`;
route=async(req: import('node:http').IncomingMessage,res:import('node:http').ServerResponse)=>{
 const url=new URL(req.url!,origin);
 if(url.pathname==='/start'){res.writeHead(302,{Location:auth});res.end();return;}
 if(url.pathname==='/client-callback'){
  if(url.searchParams.get('state')!=='preview-state'||!url.searchParams.get('code'))throw new Error();
  const r=await fetch(`${origin}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,client_secret:secret,code:url.searchParams.get('code')!,code_verifier:verifier,redirect_uri:`${origin}/client-callback`})});
  const token=await r.json();if(!r.ok)throw new Error();
  const result=await fetch(`${origin}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'get_sam_opportunities'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_sam_opportunities',arguments:{posted_from:'10/01/2026',posted_to:'10/07/2026'},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});
  const body=await result.json();if(body.result?.structuredContent?.total!==1)throw new Error();
  res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end('<!doctype html><title>Local acceptance passed</title><main style="max-width:650px;margin:10vh auto;font:20px/1.5 system-ui"><h1>Local acceptance passed</h1><p>The browser completed organization sign-in and consent. The client redeemed its authorization code and called the authenticated MCP tool successfully.</p><p><strong>Test fixture:</strong> real Better Auth sign-in with a disposable local account and simulated SAM.gov data. This is not live Gemini or SAM.gov acceptance.</p><p>One synthetic opportunity returned. No API key or access token is displayed.</p></main>');return;
 }
 if(url.pathname==='/mcp'){await app(req,res);return;}
 await broker.handle(req,res);
};
console.log(`Local synthetic acceptance: ${origin}/start`);
console.log(`Disposable local test account: ${email} / preview-password-1234`);
async function cleanup(){server.closeAllConnections();server.close();await pool.query('DELETE FROM tenants WHERE id=$1',[tenantId]);await pool.query('DELETE FROM ba_user WHERE id=$1',[user.user.id]);await pool.end();process.exit(0);}
process.once('SIGTERM',cleanup);process.once('SIGINT',cleanup);
