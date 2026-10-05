import { vi } from 'vitest';
import nodemailer from 'nodemailer';
import { jsonRequest, resolvePublic } from './network.js';
import { EvolutionTransport, SmtpTransport } from './transports.js';
import { MetaTransport, metaPage } from './meta.js';
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('./network.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./network.js')>()),
  resolvePublic: vi.fn(),
  jsonRequest: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe('provider contracts using no external network', () => {
  const c = {
    host: 'smtp.example.test',
    port: '587',
    secure: 'false',
    username: 'user',
    fromName: 'Kalend',
    fromEmail: 'from@example.test',
  };
  it('SMTP pins public IP, validates TLS hostname, disables URL/file access and separates verify from send', async () => {
    vi.stubEnv('COMMUNICATION_SMTP_HOSTS', c.host);
    vi.mocked(resolvePublic).mockResolvedValue('8.8.8.8');
    const transport = {
      verify: vi.fn().mockResolvedValue(true),
      sendMail: vi.fn().mockResolvedValue({
        accepted: ['to@example.test'],
        messageId: 'local-id',
      }),
      close: vi.fn(),
    };
    const originalClose = transport.close;
    vi.mocked(nodemailer.createTransport).mockReturnValue(transport as never);
    const adapter = new SmtpTransport();
    await adapter.verify(c, { password: 'sensitive' });
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '8.8.8.8',
        requireTLS: true,
        disableFileAccess: true,
        disableUrlAccess: true,
        tls: expect.objectContaining({
          servername: c.host,
          rejectUnauthorized: true,
        }),
      }),
    );
    expect(
      await adapter.send(
        c,
        { password: 'sensitive' },
        { to: 'to@example.test', text: 'hello', subject: 'test' },
      ),
    ).toBe('local-id');
    expect(originalClose).toHaveBeenCalled();
  });
  it('SMTP closes a hung operation at the hard deadline', async () => {
    vi.useFakeTimers();
    vi.stubEnv('COMMUNICATION_SMTP_HOSTS', c.host);
    vi.mocked(resolvePublic).mockResolvedValue('8.8.8.8');
    const transport = { verify: () => new Promise(() => {}), close: vi.fn() };
    const originalClose = transport.close;
    vi.mocked(nodemailer.createTransport).mockReturnValue(transport as never);
    const assertion = expect(
      new SmtpTransport().verify(c, { password: 'x' }),
    ).rejects.toMatchObject({ kind: 'UNCERTAIN' });
    await vi.advanceTimersByTimeAsync(20001);
    await assertion;
    expect(originalClose).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    [535, 'AUTH'],
    [450, 'TRANSIENT'],
    [550, 'PERMANENT'],
    [undefined, 'UNCERTAIN'],
  ])('sanitizes SMTP failure %s', async (code, kind) => {
    vi.stubEnv('COMMUNICATION_SMTP_HOSTS', c.host);
    vi.mocked(resolvePublic).mockResolvedValue('8.8.8.8');
    vi.mocked(nodemailer.createTransport).mockReturnValue({
      verify: vi.fn().mockRejectedValue({
        responseCode: code,
        message: 'password sensitive',
      }),
      close: vi.fn(),
    } as never);
    await expect(
      new SmtpTransport().verify(c, { password: 'secret' }),
    ).rejects.toMatchObject({ kind, message: `COMMUNICATION_${kind}` });
  });
  it('SMTP SSL uses implicit TLS, certificate validation and authentication for a real send', async () => {
    vi.mocked(resolvePublic).mockResolvedValue('8.8.8.8');
    const sendMail = vi
      .fn()
      .mockResolvedValue({ accepted: ['to@example.test'], messageId: 'id' });
    vi.mocked(nodemailer.createTransport).mockReturnValue({
      sendMail,
      close: vi.fn(),
    } as never);
    await new SmtpTransport().send(
      { ...c, host: 'smtp.gmail.com', port: '465', secure: 'true' },
      { password: 'test-only' },
      { to: 'to@example.test', subject: 'Test', text: 'Test' },
    );
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        secure: true,
        port: 465,
        auth: { user: 'user', pass: 'test-only' },
        logger: false,
        debug: false,
        tls: expect.objectContaining({
          servername: 'smtp.gmail.com',
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
        }),
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'to@example.test',
        subject: 'Test',
        text: 'Test',
      }),
    );
  });
  it('SMTP real send closes a hung mail transaction within the hard deadline', async () => {
    vi.useFakeTimers();
    vi.mocked(resolvePublic).mockResolvedValue('8.8.8.8');
    const close = vi.fn();
    vi.mocked(nodemailer.createTransport).mockReturnValue({
      sendMail: () => new Promise(() => {}),
      close,
    } as never);
    const assertion = expect(
      new SmtpTransport().send(
        { ...c, host: 'smtp.gmail.com' },
        { password: 'test-only' },
        { to: 'to@example.test', text: 'Test' },
      ),
    ).rejects.toMatchObject({ kind: 'UNCERTAIN' });
    await vi.advanceTimersByTimeAsync(20001);
    await assertion;
    expect(close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('Evolution verifies open state and uses apikey, number/text and key.id independently of Meta', async () => {
    vi.stubEnv('COMMUNICATION_EVOLUTION_HOSTS', 'evo.example.test');
    const c = { baseUrl: 'https://evo.example.test', instance: 'kalend' },
      s = { apiKey: 'secret' };
    vi.mocked(jsonRequest)
      .mockResolvedValueOnce({ instance: { state: 'open' } })
      .mockResolvedValueOnce({ key: { id: 'message-123' } });
    const a = new EvolutionTransport();
    await a.verify(c, s);
    expect(await a.send(c, s, { to: '+5511999999999', text: 'hello' })).toBe(
      'message-123',
    );
    expect(vi.mocked(jsonRequest).mock.calls[1]).toEqual([
      new URL('https://evo.example.test/message/sendText/kalend'),
      { apikey: 'secret' },
      { number: '5511999999999', text: 'hello', linkPreview: false },
    ]);
  });
  it('Evolution rejects disconnected state and missing send id', async () => {
    vi.stubEnv('COMMUNICATION_EVOLUTION_HOSTS', 'evo.example.test');
    const c = { baseUrl: 'https://evo.example.test', instance: 'kalend' };
    vi.mocked(jsonRequest).mockResolvedValue({ instance: { state: 'close' } });
    await expect(
      new EvolutionTransport().verify(c, { apiKey: 'key' }),
    ).rejects.toMatchObject({ kind: 'PERMANENT' });
    await expect(
      new EvolutionTransport().send(
        c,
        { apiKey: 'key' },
        { to: '+5511999999999', text: 'x' },
      ),
    ).rejects.toMatchObject({ kind: 'UNCERTAIN' });
  });
  it('Evolution pairing returns only validated temporary PNG, never apiKey or arbitrary payload', async () => {
    vi.stubEnv('COMMUNICATION_EVOLUTION_HOSTS', 'evo.example.test');
    const c = { baseUrl: 'https://evo.example.test', instance: 'kalend' },
      s = { apiKey: 'private' };
    const png =
      'data:image/png;base64,' +
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    vi.mocked(jsonRequest)
      .mockResolvedValueOnce({
        base64: png,
        apikey: 'leak',
        pairingCode: 'sensitive',
      })
      .mockResolvedValueOnce({ base64: 'data:image/svg+xml;base64,evil' });
    expect(await new EvolutionTransport().pair(c, s)).toEqual({
      connected: false,
      qrCode: png,
    });
    await expect(new EvolutionTransport().pair(c, s)).rejects.toThrow();
  });
  const meta = {
      graphVersion: 'v25.0',
      phoneNumberId: '123',
      businessAccountId: '456',
    },
    token = { accessToken: 'secret' };
  const template = {
    id: '789',
    name: 'welcome',
    language: 'pt_BR',
    category: 'UTILITY',
    status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Olá {{1}}' }],
  };
  const message = {
    to: '+5511999999999',
    text: '',
    meta: {
      id: '789',
      name: 'welcome',
      language: 'pt_BR',
      parameters: ['Owner'],
    },
  };
  it('Meta sends only after checking official status and matching id/language/body parameters', async () => {
    vi.stubEnv('COMMUNICATION_META_GRAPH_VERSION', 'v25.0');
    vi.mocked(jsonRequest)
      .mockResolvedValueOnce({ data: [template] })
      .mockResolvedValueOnce({ messages: [{ id: 'wamid.example' }] });
    expect(await new MetaTransport().send(meta, token, message)).toBe(
      'wamid.example',
    );
    expect(vi.mocked(jsonRequest).mock.calls[1]).toEqual([
      new URL('https://graph.facebook.com/v25.0/123/messages'),
      { Authorization: 'Bearer secret' },
      expect.objectContaining({
        type: 'template',
        messaging_product: 'whatsapp',
        template: expect.objectContaining({
          components: [
            { type: 'body', parameters: [{ type: 'text', text: 'Owner' }] },
          ],
        }),
      }),
    ]);
  });
  it.each(['PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'UNKNOWN'])(
    'Meta never assumes approval for %s',
    async (status) => {
      vi.stubEnv('COMMUNICATION_META_GRAPH_VERSION', 'v25.0');
      vi.mocked(jsonRequest).mockResolvedValue({
        data: [{ ...template, status }],
      });
      await expect(
        new MetaTransport().send(meta, token, message),
      ).rejects.toMatchObject({ kind: 'TEMPLATE' });
      expect(jsonRequest).toHaveBeenCalledTimes(1);
    },
  );
  it('Meta never follows a provider supplied paging URL with credentials', async () => {
    vi.stubEnv('COMMUNICATION_META_GRAPH_VERSION', 'v25.0');
    vi.mocked(jsonRequest).mockResolvedValue({
      data: [template],
      paging: { next: 'http://127.0.0.1/token', cursors: { after: 'cursor' } },
    });
    expect((await metaPage(meta, token)).after).toBe('cursor');
    expect(jsonRequest).toHaveBeenCalledTimes(1);
  });
});
