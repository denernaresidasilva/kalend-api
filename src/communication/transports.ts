import { connect, type Socket } from 'node:net';
import { MetaTransport } from './meta.js';
import nodemailer from 'nodemailer';
import { GmailTransport } from './gmail.js';
import { GlobalPush } from './push.js';
import { Inject, Injectable } from '@nestjs/common';
import { allowedHost, jsonRequest, resolvePublic } from './network.js';
import { email, TransportFailure } from './contracts.js';
import type { Message, Provider, Transport, Variables } from './contracts.js';
export class SmtpTransport implements Transport {
  async connection(c: Variables, s: Variables) {
    allowedHost(c.host, 'COMMUNICATION_SMTP_HOSTS');
    const address = await resolvePublic(c.host);
    let socket: Socket | undefined;
    const transport = nodemailer.createTransport({
      getSocket: (_options, callback) => {
        let done = false;
        const finish = (error: Error | null) => {
          if (done) return;
          done = true;
          callback(error, error ? undefined : { connection: socket! });
        };
        socket = connect({ host: address, port: Number(c.port) });
        const dialTimer = setTimeout(
          () => socket?.destroy(new Error('SMTP_CONNECTION_TIMEOUT')),
          10000,
        );
        socket.once('close', () => clearTimeout(dialTimer));
        socket.once('connect', () => {
          clearTimeout(dialTimer);
          finish(null);
        });
        socket.once('error', () => finish(new Error('SMTP_CONNECTION_FAILED')));
      },
      host: address,
      port: Number(c.port),
      secure: c.secure === 'true',
      requireTLS: true,
      opportunisticTLS: false,
      tls: {
        servername: c.host,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      },
      auth: { user: c.username, pass: s.password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
    const close = transport.close.bind(transport);
    transport.close = () => {
      socket?.destroy();
      close();
    };
    return transport;
  }
  async run<T>(
    c: Variables,
    s: Variables,
    operation: (
      t: Awaited<ReturnType<SmtpTransport['connection']>>,
    ) => Promise<T>,
  ): Promise<T> {
    const t = await this.connection(c, s);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(t),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            t.close();
            reject(new TransportFailure('UNCERTAIN'));
          }, 20000);
        }),
      ]);
    } catch (e) {
      if (e instanceof TransportFailure) throw e;
      const code = (e as { responseCode?: number }).responseCode;
      throw new TransportFailure(
        code === 535
          ? 'AUTH'
          : code && code >= 400 && code < 500
            ? 'TRANSIENT'
            : code && code >= 500
              ? 'PERMANENT'
              : 'UNCERTAIN',
      );
    } finally {
      if (timer) clearTimeout(timer);
      t.close();
    }
  }
  async verify(c: Variables, s: Variables) {
    await this.run(c, s, (t) => t.verify());
  }
  async send(c: Variables, s: Variables, m: Message) {
    return this.run(c, s, async (t) => {
      const result = await t.sendMail({
        from: { name: c.fromName, address: email(c.fromEmail) },
        replyTo: c.replyTo ? email(c.replyTo) : undefined,
        to: email(m.to),
        subject: m.subject,
        text: m.text,
        html: m.html,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (!result.accepted.length) throw new TransportFailure('RECIPIENT');
      return String(result.messageId);
    });
  }
}
export class EvolutionTransport implements Transport {
  url(c: Variables, path: string) {
    const base = new URL(c.baseUrl);
    allowedHost(base.hostname, 'COMMUNICATION_EVOLUTION_HOSTS');
    return new URL(`${path}/${encodeURIComponent(c.instance)}`, base);
  }
  async pair(c: Variables, s: Variables) {
    const result = await jsonRequest(this.url(c, '/instance/connect'), {
      apikey: s.apiKey,
    });
    if ((result.instance as { state?: unknown } | undefined)?.state === 'open')
      return { connected: true };
    const qr = (result.qrcode ?? result) as Record<string, unknown>;
    if (
      typeof qr.base64 !== 'string' ||
      !/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(qr.base64) ||
      qr.base64.length > 200000 ||
      !Buffer.from(qr.base64.split(',')[1], 'base64')
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new TransportFailure('PERMANENT');
    return { connected: false, qrCode: qr.base64 };
  }
  async verify(c: Variables, s: Variables) {
    const r = await jsonRequest(this.url(c, '/instance/connectionState'), {
      apikey: s.apiKey,
    });
    if ((r.instance as { state?: unknown } | undefined)?.state !== 'open')
      throw new TransportFailure('PERMANENT');
  }
  async send(c: Variables, s: Variables, m: Message) {
    const r = await jsonRequest(
      this.url(c, '/message/sendText'),
      { apikey: s.apiKey },
      { number: m.to.slice(1), text: m.text, linkPreview: false },
    );
    const id = (r.key as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))
      throw new TransportFailure('UNCERTAIN');
    return id;
  }
}
/** Capabilities without verified end-to-end contract are deliberately unavailable. */
export class PendingTransport implements Transport {
  async verify(_c: Variables, _s: Variables): Promise<void> {
    throw new TransportFailure('PERMANENT');
  }
  async send(_c: Variables, _s: Variables, _m: Message): Promise<string> {
    throw new TransportFailure('PERMANENT');
  }
}
@Injectable()
export class CommunicationTransports {
  constructor(
    @Inject(GmailTransport) private readonly gmail?: GmailTransport,
    @Inject(GlobalPush) private readonly push?: GlobalPush,
  ) {}
  get(provider: Provider): Transport {
    if (provider === 'GMAIL' && this.gmail) return this.gmail;
    if (provider === 'PUSH_PENDING' && this.push) return this.push;
    if (provider === 'META') return new MetaTransport();
    if (provider === 'SMTP') return new SmtpTransport();
    if (provider === 'EVOLUTION') return new EvolutionTransport();
    return new PendingTransport();
  }
  available(provider: Provider) {
    return (
      provider === 'SMTP' ||
      provider === 'EVOLUTION' ||
      provider === 'META' ||
      (provider === 'GMAIL' && !!this.gmail) ||
      (provider === 'PUSH_PENDING' && !!this.push)
    );
  }
}
