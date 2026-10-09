import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Provider, { errors, type Configuration } from 'oidc-provider';
import { READ_SCOPE, type VerifyToken } from './auth.js';
import type { BetterLogin } from './better-login.js';
import { fromNodeHeaders } from 'better-auth/node';
import { OAuthStore } from './oauth-store.js';
import { saveSamKey, type Fetch } from './opportunities.js';
import { TenantStore } from './tenant-store.js';

const random = () => randomBytes(32).toString('base64url');
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — SAM.gov MCP</title><style>body{font:17px/1.55 system-ui,sans-serif;color:#18242b;background:#f3f5f4;margin:0}main{max-width:620px;margin:7vh auto;padding:36px;background:white;border:1px solid #d6dfdd;border-radius:12px}h1{font-size:28px;line-height:1.2}label{display:block;margin:20px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #82918e;border-radius:4px;font:inherit}button,.button{display:inline-block;background:#145f55;color:white;border:0;padding:12px 20px;border-radius:5px;text-decoration:none;font:inherit;cursor:pointer;margin:12px 10px 0 0}small{display:block;color:#495d57}.muted{color:#495d57}a{color:#145f55}@media(max-width:700px){main{margin:20px;padding:24px}}</style><main><p class="muted">BLEN · SAM.gov MCP</p><h1>${esc(title)}</h1>${body}</main></html>`;
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded')
    throw new Error('Invalid form.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('Form is too large.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export type BrokerOptions = {
  publicUrl: string;
  store: OAuthStore;
  tenants: TenantStore;
  jwks: NonNullable<Configuration['jwks']>;
  cookieKeys: string[];
  login: BetterLogin;
  allowLocalHttp?: boolean;
  fetcher?: Fetch;
};

export function createBroker(options: BrokerOptions) {
  const origin = new URL(options.publicUrl).origin;
  const resource = `${origin}/mcp`;
  const local =
    options.allowLocalHttp === true &&
    ['localhost', '127.0.0.1'].includes(new URL(origin).hostname) &&
    new URL(origin).protocol === 'http:';
  if (!local && !origin.startsWith('https://')) throw new Error('HTTPS is required.');
  if (!options.cookieKeys.length || options.cookieKeys.some((k) => k.length < 43))
    throw new Error('Strong persistent cookie keys are required.');
  const provider = new Provider(origin, {
    adapter: (model) => options.store.adapter(model),
    jwks: options.jwks,
    cookies: {
      keys: options.cookieKeys,
      long: { secure: !local, sameSite: 'lax', httpOnly: true },
      short: { secure: !local, sameSite: 'lax', httpOnly: true },
    },
    clients: [],
    claims: { openid: ['sub'] },
    scopes: ['openid', 'offline_access', READ_SCOPE],
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      revocation: {
        enabled: true,
        allowedPolicy: (_ctx, client, token) => token.clientId === client.clientId,
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: async (_ctx, indicator, client) => {
          if (indicator !== resource) throw new errors.InvalidTarget();
          const found = await options.store.pool.query(
            'SELECT 1 FROM tenant_clients c JOIN tenants t ON t.id=c.tenant_id WHERE c.issuer=$1 AND c.client_id=$2 AND t.enabled',
            [origin, client.clientId],
          );
          if (!found.rowCount) throw new errors.InvalidTarget();
          return {
            scope: READ_SCOPE,
            audience: resource,
            accessTokenTTL: 900,
            accessTokenFormat: 'opaque',
          };
        },
      },
    },
    rotateRefreshToken: true,
    ttl: {
      AccessToken: 900,
      IdToken: 900,
      AuthorizationCode: 60,
      Interaction: 600,
      RefreshToken: 30 * 86400,
      Grant: 30 * 86400,
      Session: 86400,
    },
    routes: {
      authorization: '/oauth/authorize',
      token: '/oauth/token',
      revocation: '/oauth/revoke',
      jwks: '/oauth/jwks',
      end_session: '/oauth/logout',
    },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    findAccount: async (_ctx, id) => {
      const result = await options.store.pool.query(
        'SELECT 1 FROM accounts WHERE id=$1 AND enabled',
        [id],
      );
      return result.rowCount ? { accountId: id, claims: async () => ({ sub: id }) } : undefined;
    },
    renderError: async (ctx) => {
      ctx.type = 'html';
      ctx.body = page(
        'Connection could not be completed',
        '<p>The request was invalid, expired, or not authorized. Return to Gemini and reconnect.</p>',
      );
    },
  });
  provider.proxy = !local;
  provider.on('server_error', () => console.error('OAuth request failed.'));
  provider.silent = true;

  const verify: VerifyToken = async (token) => {
    const access = await provider.AccessToken.find(token);
    if (
      !access?.accountId ||
      !access.clientId ||
      access.isExpired ||
      access.aud !== resource ||
      !access.grantId
    )
      throw new Error('Invalid token.');
    if (!(await provider.Grant.find(access.grantId))) throw new Error('Revoked grant.');
    const active = await options.store.pool.query(
      'SELECT 1 FROM accounts WHERE id=$1 AND enabled',
      [access.accountId],
    );
    if (!active.rowCount) throw new Error('Inactive account.');
    return {
      issuer: origin,
      subject: access.accountId,
      clientId: access.clientId,
      scopes: [...access.scopes],
    };
  };

  function html(
    res: ServerResponse,
    title: string,
    body: string,
    status = 200,
    nonce?: string,
    clientOrigin?: string,
  ) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; form-action 'self' https://accounts.google.com${clientOrigin ? ` ${clientOrigin}` : ''}; frame-ancestors 'none'; base-uri 'none'`,
    });
    res.end(page(title, body));
  }
  function redirect(res: ServerResponse, url: string) {
    res.writeHead(303, {
      Location: url,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'same-origin',
    });
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, origin);
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== origin) {
      html(res, 'Request rejected', '<p>Origin not allowed.</p>', 403);
      return;
    }
    if (!(await options.store.allow(`oauth-ip:${req.socket.remoteAddress}`, 120, 60))) {
      html(res, 'Please wait', '<p>Too many requests. Try again in a minute.</p>', 429);
      return;
    }
    if (url.pathname === '/') {
      html(
        res,
        'Connect SAM.gov to Gemini',
        '<p>Search federal contract opportunities using your organization’s SAM.gov key.</p><p>Your administrator configures this service in Gemini Enterprise. Start the connection there, then sign in with your invited account. Better Auth manages Google sign-in and email/password accounts. Organization access requires an invitation.</p><small>Each organization has a separate encrypted credential. Keys are never sent to Gemini.</small>',
      );
      return;
    }
    if (
      url.pathname === '/account/auth/callback/google' &&
      req.method === 'GET' &&
      options.login.googleEnabled
    ) {
      const result = await options.login.auth.handler(
        new Request(url, { headers: fromNodeHeaders(req.headers) }),
      );
      if (result.status >= 400) {
        html(
          res,
          'Google sign-in could not be completed',
          '<p>Use the verified Google account invited to your organization. Return to Gemini and try again.</p>',
          403,
        );
        return;
      }
      result.headers.forEach((value, key) => {
        if (key !== 'set-cookie') res.setHeader(key, value);
      });
      res.setHeader('Set-Cookie', result.headers.getSetCookie());
      res.statusCode = result.status;
      res.end(await result.text());
      return;
    }
    if (url.pathname === '/account/signin-error') {
      html(
        res,
        'Google sign-in could not be completed',
        '<p>Use the verified Google account invited to your organization. Return to Gemini and start a new connection, or ask your administrator to check access.</p>',
        403,
      );
      return;
    }
    if (url.pathname === '/account/setup') {
      if (req.method === 'GET') {
        const csrf = random(),
          nonce = random();
        await options.store.put('SetupForm', csrf, { valid: true });
        res.setHeader(
          'Set-Cookie',
          `setup_csrf=${csrf}; HttpOnly; SameSite=Strict; Path=/account/setup; Max-Age=600${local ? '' : '; Secure'}`,
        );
        html(
          res,
          'Set your password',
          `<p>Use the private setup link supplied by your service administrator. Links expire after one hour and work once.</p><form method="post" action="/account/setup"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="token" id="token"><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><small>Use at least 12 characters.</small><button>Save password</button></form><script nonce="${nonce}">document.getElementById('token').value=new URLSearchParams(location.hash.slice(1)).get('token')||'';history.replaceState(null,'',location.pathname);</script>`,
          200,
          nonce,
        );
        return;
      }
      if (req.method === 'POST') {
        try {
          if (req.headers.origin !== origin) throw new Error();
          const data = await form(req),
            csrf = data.get('csrf') ?? '';
          const cookies = Object.fromEntries(
            (req.headers.cookie ?? '').split(';').map((v) => v.trim().split('=')),
          );
          if (
            !equal(csrf, cookies.setup_csrf ?? '') ||
            !(await options.store.take('SetupForm', csrf))
          )
            throw new Error();
          await options.login.auth.api.resetPassword({
            body: { token: data.get('token') ?? '', newPassword: data.get('password') ?? '' },
          });
          res.setHeader(
            'Set-Cookie',
            `setup_csrf=; HttpOnly; SameSite=Strict; Path=/account/setup; Max-Age=0${local ? '' : '; Secure'}`,
          );
          html(
            res,
            'Password saved',
            '<p>Your account is ready. Return to Gemini Enterprise and connect SAM.gov using your email and password.</p>',
          );
        } catch {
          html(
            res,
            'Setup could not be completed',
            '<p>The link may have expired or already been used, or the password did not meet the requirements. Ask your administrator for a new link.</p>',
            400,
          );
        }
        return;
      }
      html(res, 'Request rejected', '<p>Method not allowed.</p>', 405);
      return;
    }
    // Better Auth is called through the guarded forms below. Its signup, admin,
    // account linking and password-reset request APIs are never publicly mounted.
    if (url.pathname.startsWith('/account/')) {
      html(res, 'Not found', '<p>This page is unavailable.</p>', 404);
      return;
    }
    const match =
      /^\/interaction\/([A-Za-z0-9_-]+)(?:\/(login|google|complete|confirm|disconnect))?$/.exec(
        url.pathname,
      );
    if (match) {
      try {
        const details = await provider.interactionDetails(req, res);
        if (details.uid !== match[1]) throw new Error();
        const clientId = String(details.params.client_id);
        const action = match[2];
        const client = await provider.Client.find(clientId);
        const callback = String(details.params.redirect_uri);
        if (!client?.redirectUriAllowed(callback)) throw new Error();
        const callbackUrl = new URL(callback);
        if (!['http:', 'https:'].includes(callbackUrl.protocol)) throw new Error();
        // Browsers apply form-action to the final OAuth redirect, too. Only allow
        // the origin of this provider-validated, registered client callback.
        const clientOrigin = callbackUrl.origin;
        if (action === 'google' && req.method === 'POST') {
          if (req.headers.origin !== origin) throw new Error();
          const data = await form(req);
          const expected = await options.store.take<{ csrf: string }>('LoginForm', details.uid);
          if (!expected || !equal(expected.csrf, data.get('csrf') ?? '')) throw new Error();
          if (!options.login.googleEnabled) {
            html(
              res,
              'Google sign-in setup required',
              '<p>The service administrator must configure Google sign-in before this option can be used.</p>',
              503,
            );
            return;
          }
          const result = await options.login.auth.api.signInSocial({
            body: {
              provider: 'google',
              callbackURL: `${origin}/interaction/${encodeURIComponent(details.uid)}/complete`,
              errorCallbackURL: `${origin}/account/signin-error`,
              disableRedirect: true,
            },
            headers: fromNodeHeaders(req.headers),
            asResponse: true,
          });
          if (!result.ok) throw new Error();
          const target = (await result.json()).url;
          if (
            typeof target !== 'string' ||
            new URL(target).origin !== 'https://accounts.google.com'
          )
            throw new Error();
          res.setHeader('Set-Cookie', result.headers.getSetCookie());
          redirect(res, target);
          return;
        }
        if (action === 'login' && req.method === 'POST') {
          if (req.headers.origin !== origin) throw new Error();
          const data = await form(req);
          const expected = await options.store.take<{ csrf: string }>('LoginForm', details.uid);
          if (!expected || !equal(expected.csrf, data.get('csrf') ?? '')) throw new Error();
          const email = (data.get('email') ?? '').toLowerCase();
          if (!(await options.store.allow(`signin:${email}`, 10, 300))) {
            html(
              res,
              'Please wait',
              '<p>Too many sign-in attempts. Try again in five minutes.</p>',
              429,
            );
            return;
          }
          const result = await options.login.auth.api.signInEmail({
            body: { email, password: data.get('password') ?? '' },
            headers: fromNodeHeaders(req.headers),
            asResponse: true,
          });
          if (!result.ok) {
            html(
              res,
              'Sign-in failed',
              `<p>The email or password was not accepted.</p><a href="/interaction/${esc(details.uid)}">Try again</a>`,
              401,
            );
            return;
          }
          res.setHeader('Set-Cookie', result.headers.getSetCookie());
          redirect(res, `/interaction/${encodeURIComponent(details.uid)}/complete`);
          return;
        }
        if (action === 'complete' && req.method === 'GET') {
          const identity = await options.login.identity(fromNodeHeaders(req.headers));
          const accountId =
            identity && (await options.store.bindIdentity(origin, clientId, identity));
          if (!accountId) {
            html(
              res,
              'Organization access required',
              '<p>This account has not been invited to this organization, or access has been disabled. Ask your administrator to check your membership.</p>',
              403,
            );
            return;
          }
          await provider.interactionFinished(
            req,
            res,
            { login: { accountId, remember: false } },
            { mergeWithLastSubmission: false },
          );
          return;
        }
        if (details.prompt.name === 'login' && req.method === 'GET' && !action) {
          const csrf = random();
          await options.store.put('LoginForm', details.uid, { csrf });
          html(
            res,
            'Sign in to your organization',
            `<p>Use the account invited by your organization administrator.</p><form method="post" action="/interaction/${esc(details.uid)}/google"><input type="hidden" name="csrf" value="${csrf}"><button${options.login.googleEnabled ? '' : ' disabled'}>Continue with Google</button></form>${options.login.googleEnabled ? '<small>Use your invited Google account. No separate password setup is needed.</small>' : '<small>Google sign-in is awaiting service configuration.</small>'}<form method="post" action="/interaction/${esc(details.uid)}/login"><input type="hidden" name="csrf" value="${csrf}"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="128" required><button>Sign in</button></form><small>Sign-in is managed by Better Auth. For account setup or password recovery, ask your administrator for a private setup link.</small>`,
            200,
            undefined,
            clientOrigin,
          );
          return;
        }
        const accountId = details.session?.accountId;
        if (!accountId) throw new Error();
        const principal = { issuer: origin, subject: accountId, clientId };
        const membership = await options.tenants.resolve(principal);
        if (!membership) {
          html(
            res,
            'Access unavailable',
            '<p>Your organization access has been disabled.</p>',
            403,
          );
          return;
        }
        const tenant = await options.store.pool.query<{ name: string }>(
          'SELECT name FROM tenants WHERE id=$1',
          [membership.tenantId],
        );
        // Renders the consent form with a fresh single-use CSRF token, optionally after an error.
        const consentForm = async (error?: string) => {
          const csrf = random();
          await options.store.put('ConsentForm', details.uid, { csrf });
          const hasKey = !!(await options.tenants.keyFor(principal));
          const clientName = client?.clientName || 'MCP client';
          html(
            res,
            `Authorize ${clientName}`,
            `${error ? `<p role="alert"><strong>${esc(error)}</strong></p>` : ''}<p>Connect ${esc(clientName)} to <strong>${esc(tenant.rows[0]?.name)}</strong> for read-only SAM.gov opportunity searches.</p><form method="post" action="/interaction/${esc(details.uid)}/confirm"><input type="hidden" name="csrf" value="${csrf}">${membership.role === 'admin' ? `<h2>${hasKey ? 'Your organization’s SAM.gov key' : 'Add your organization’s SAM.gov key'}</h2><p>Use a <strong>SAM.gov system-account API key</strong> that your organization is allowed to use for public opportunity searches. Everyone with access to this organization can search using this key.</p><p><strong>Do not enter a personal API key.</strong> Personal keys are for one person. This connection shares one key across your organization.</p><p>Need a key? Ask the person who manages your organization’s SAM.gov system account, or see <a href="https://sam.gov/help">SAM.gov Help</a> under <strong>Using Data Services → APIs</strong>.</p><label for="api_key">${hasKey ? 'Replace the saved key (optional)' : 'SAM.gov system-account API key'}</label><input id="api_key" type="password" name="api_key" autocomplete="off" aria-describedby="key-help key-storage" maxlength="4096"${hasKey ? '' : ' required'}><small id="key-help">${hasKey ? 'Leave this blank to keep the current key. A replacement changes the key for everyone in your organization.' : 'Paste the API key here. We do not need your SAM.gov password.'}</small><p id="key-storage">We store the key encrypted and use it on the server. Your AI assistant never receives the key. When you save it, we run one small SAM.gov search to check that SAM.gov accepts it.</p>` : `<p>${hasKey ? 'Searches use your organization’s saved SAM.gov key. You do not need to enter a personal key.' : 'Ask an organization administrator to add a SAM.gov system-account API key before you connect.'}</p>`}<button name="decision" value="allow"${!hasKey && membership.role !== 'admin' ? ' disabled' : ''}>Authorize connection</button><button name="decision" value="deny">Cancel</button></form><small>Disconnect through your MCP client to stop using this connection. An administrator can revoke all grants using the service management command.</small>`,
            error ? 400 : 200,
            undefined,
            clientOrigin,
          );
        };
        if (req.method === 'GET' && !action) {
          await consentForm();
          return;
        }
        if (action === 'confirm' && req.method === 'POST') {
          const body = await form(req);
          const saved = await options.store.take<{ csrf: string }>('ConsentForm', details.uid);
          if (!saved || !equal(body.get('csrf') ?? '', saved.csrf)) throw new Error();
          if (body.get('decision') !== 'allow') {
            await provider.interactionFinished(
              req,
              res,
              { error: 'access_denied', error_description: 'The user declined the connection.' },
              { mergeWithLastSubmission: false },
            );
            return;
          }
          const key = body.get('api_key');
          if (key) {
            if (membership.role !== 'admin') throw new Error();
            const result = await saveSamKey(
              key,
              (k) => options.tenants.setKey(principal, k),
              options.fetcher,
            );
            if (result.status === 'forbidden') throw new Error();
            if (result.status !== 'saved') {
              // Show the form again so the admin can try another key, or leave the field
              // blank to keep a key the organization already has.
              await consentForm(
                result.status === 'rejected'
                  ? result.message
                  : 'That does not look like a SAM.gov API key. Check for missing characters or spaces.',
              );
              return;
            }
          }
          if (!(await options.tenants.keyFor(principal))) {
            html(
              res,
              'SAM.gov key required',
              '<p>An organization administrator must connect a key before authorizing this connection.</p>',
              400,
            );
            return;
          }
          const grant = details.grantId
            ? await provider.Grant.find(details.grantId)
            : new provider.Grant({ accountId, clientId });
          if (!grant) throw new Error();
          const requested = new Set(String(details.params.scope ?? '').split(' '));
          for (const scope of ['openid', 'offline_access', READ_SCOPE])
            if (requested.has(scope)) grant.addOIDCScope(scope);
          grant.addResourceScope(resource, READ_SCOPE);
          const grantId = await grant.save();
          await provider.interactionFinished(
            req,
            res,
            { consent: { grantId } },
            { mergeWithLastSubmission: true },
          );
          return;
        }
        throw new Error();
      } catch {
        if (!res.headersSent)
          html(
            res,
            'Connection expired',
            '<p>Return to Gemini and start a new connection.</p>',
            400,
          );
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      res.once('finish', resolve);
      res.once('close', resolve);
      Promise.resolve(provider.callback()(req, res)).catch(reject);
    });
  }
  return { provider, verify, handle };
}
