import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Development only: authenticated loopback UI, isolated encrypted token storage.
process.umask(0o077);
const directory = resolve('.local/inspector');
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const config = resolve(process.env.SAM_INSPECTOR_CONFIG || `${directory}/config.json`);
if (!existsSync(config)) {
  console.error('Provision a development client with manage create-inspector-client; see README.');
  process.exit(1);
}
const keyFile = `${directory}/storage.key`;
if (!existsSync(keyFile))
  writeFileSync(keyFile, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 });
const cli = process.argv[2] === '--cli';
const env = {
  ...process.env,
  HOST: '127.0.0.1',
  CLIENT_PORT: '6274',
  MCP_AUTO_OPEN_ENABLED: 'false',
  MCP_INSPECTOR_API_TOKEN: randomBytes(32).toString('base64url'),
  MCP_STORAGE_DIR: directory,
  MCP_INSPECTOR_SECRET_STORE: 'file',
  MCP_INSPECTOR_SECRET_FILE: `${directory}/secrets.json`,
  MCP_INSPECTOR_SECRET_KEY_FILE: keyFile,
};
for (const name of [
  'DANGEROUSLY_OMIT_AUTH',
  'DANGEROUSLY_BIND_ALL_INTERFACES',
  'ALLOWED_ORIGINS',
  'MCP_CATALOG_PATH',
  'MCP_LOG_FILE',
  'MCP_INSPECTOR_SECRET_KEY',
])
  delete env[name];
const args = cli
  ? [
      '--cli',
      '--config',
      config,
      '--server',
      'samgov-production',
      '--stored-auth-only',
      ...process.argv.slice(3),
    ]
  : ['--web', '--config', config];
const child = spawn(resolve('node_modules/.bin/mcp-inspector'), args, {
  env,
  stdio: cli ? 'inherit' : ['ignore', 'pipe', 'pipe'],
});
if (!cli) {
  // The Inspector banner includes a bearer token; do not print or save its logs.
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  console.log('MCP Inspector: http://127.0.0.1:6274 (local development only).');
  console.log('Tokens are encrypted under .local/inspector. Stop with Ctrl+C.');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  console.error('Inspector could not start. Check Node version and npm install.');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (code && !cli)
    console.error('Inspector failed. Check configuration and whether port 6274 is already in use.');
  process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
});
