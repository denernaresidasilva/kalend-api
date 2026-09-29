import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import { TransportFailure } from './contracts.js';
export function publicIp(address: string) {
  try {
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function allowedHost(host: string, policy: string) {
  const hosts = (process.env[policy] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
    isIP(host) ||
    !hosts.includes(host)
  )
    throw new TransportFailure('PERMANENT');
}
export async function resolvePublic(host: string) {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  const results = await Promise.allSettled([
    resolver.resolve4(host),
    resolver.resolve6(host),
  ]);
  const addresses = results.flatMap((r) =>
    r.status === 'fulfilled' ? r.value : [],
  );
  if (!addresses.length) throw new TransportFailure('TRANSIENT');
  if (addresses.some((a) => !publicIp(a)))
    throw new TransportFailure('PERMANENT');
  return addresses[0];
}
/** DNS is resolved once and the public IP is pinned to the socket; TLS still validates the hostname. */
export async function jsonRequest(
  url: URL,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Record<string, unknown>> {
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
    const fail = (kind: 'PERMANENT' | 'UNCERTAIN' | 'AUTH' | 'RATE_LIMIT') =>
      reject(new TransportFailure(kind));
    const req = request(
      url,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        agent: false,
        family: isIP(address),
        lookup: (_hostname, _options, cb) => cb(null, address, isIP(address)),
        servername: url.hostname,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 262144) {
            req.destroy();
            fail('UNCERTAIN');
          } else chunks.push(chunk);
        });
        res.on('error', () => fail('UNCERTAIN'));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300)
            return fail(
              status === 401 || status === 403
                ? 'AUTH'
                : status === 429
                  ? 'RATE_LIMIT'
                  : status >= 500
                    ? 'UNCERTAIN'
                    : 'PERMANENT',
            );
          try {
            const parsed: unknown = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            );
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              throw new Error();
            resolve(parsed as Record<string, unknown>);
          } catch {
            fail('UNCERTAIN');
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      fail('UNCERTAIN');
    }, 15000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => fail('UNCERTAIN'));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
