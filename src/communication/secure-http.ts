import { request } from 'node:https';
import { isIP } from 'node:net';
import { resolvePublic } from './network.js';
import { TransportFailure } from './contracts.js';

export type HttpResult = { status: number; body: Buffer };
/** Bounded, no redirects, public DNS pinned to TLS socket. No remote errors escape. */
export async function secureRequest(
  url: URL,
  method: 'GET' | 'POST' | 'DELETE',
  headers: Record<string, string>,
  body?: Buffer,
  maxBytes = 65536,
): Promise<HttpResult> {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new TransportFailure('PERMANENT');
  const address = await resolvePublic(url.hostname);
  return new Promise((resolve, reject) => {
    let connected = false;
    const fail = () =>
      reject(
        new TransportFailure(
          method === 'POST' && connected ? 'UNCERTAIN' : 'TRANSIENT',
        ),
      );
    const req = request(
      url,
      {
        method,
        headers,
        agent: false,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        servername: url.hostname,
        family: isIP(address),
        lookup: (_host, _options, cb) => cb(null, address, isIP(address)),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            fail();
          } else chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('socket', (socket) =>
      socket.once('secureConnect', () => {
        connected = true;
      }),
    );
    const timer = setTimeout(() => {
      req.destroy();
      fail();
    }, 15000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', fail);
    req.end(body);
  });
}

export function responseObject(result: HttpResult): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(result.body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new TransportFailure('UNCERTAIN');
  }
}
