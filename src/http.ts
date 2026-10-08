import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { hostHeaderValidation } from '@modelcontextprotocol/node';

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

export function requestListener(
  publicUrl: string,
  app: Handler,
  broker?: Handler,
): RequestListener {
  const address = new URL(publicUrl);
  const validateHost = hostHeaderValidation([
    address.hostname,
    'localhost',
    '127.0.0.1',
    'healthcheck.railway.app',
  ]);
  return (request, response) => {
    const dispatch = async () => {
      if (!validateHost(request, response)) return;
      // This is an origin server, never a forward proxy. Reject malformed and
      // authority/absolute-form targets before URL parsing can throw or reroute.
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end('{"error":"invalid_request_target"}');
        return;
      }
      const path = new URL(request.url, address).pathname;
      if (
        broker &&
        ![
          '/mcp',
          '/admin/credential',
          '/healthz',
          '/.well-known/oauth-protected-resource/mcp',
        ].includes(path)
      )
        await broker(request, response);
      else await app(request, response);
    };
    void dispatch().catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end('{"error":"internal_error"}');
    });
  };
}
