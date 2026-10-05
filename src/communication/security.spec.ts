import { randomBytes } from 'node:crypto';
import { SecretVault } from '../billing/secret-vault.js';
import {
  credentialScope,
  mergeSecrets,
  validateConfig,
} from './configuration.js';
import {
  channels,
  email,
  EVENTS,
  phone,
  render,
  renderText,
  retry,
  templateContent,
  TransportFailure,
  variablesFor,
} from './contracts.js';
import { allowedHost, publicIp } from './network.js';
import { CommunicationTransports } from './transports.js';
import { metaUrl } from './meta.js';
describe('global communication security contracts', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('isolates encrypted credentials by domain/provider/environment and detects tampering', () => {
    vi.stubEnv('GATEWAY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    const v = new SecretVault(),
      scope = credentialScope('SMTP', 'SANDBOX'),
      cipher = v.encrypt('secret', scope);
    expect(cipher).not.toContain('secret');
    expect(v.decrypt(cipher, scope)).toBe('secret');
    for (const other of [
      'SMTP:SANDBOX:credentials',
      credentialScope('SMTP', 'PRODUCTION'),
      credentialScope('META', 'SANDBOX'),
    ])
      expect(() => v.decrypt(cipher, other)).toThrow();
    expect(() => v.decrypt(cipher.slice(0, -3) + 'BAD', scope)).toThrow();
  });
  it('preserves absent/empty secrets, explicitly clears null and rejects mass assignment', () => {
    expect(mergeSecrets('SMTP', { password: 'existing' }, undefined)).toEqual({
      password: 'existing',
    });
    expect(
      mergeSecrets('SMTP', { password: 'existing' }, { password: '' }),
    ).toEqual({ password: 'existing' });
    expect(
      mergeSecrets('SMTP', { password: 'existing' }, { password: null }),
    ).toEqual({});
    expect(() => mergeSecrets('SMTP', {}, { apiKey: 'bad' })).toThrow();
    expect(() =>
      mergeSecrets('GMAIL', {}, { password: 'google-account' }),
    ).toThrow();
    expect(
      mergeSecrets(
        'GMAIL',
        {},
        { clientSecret: 'client', refreshToken: 'refresh' },
      ),
    ).toEqual({ clientSecret: 'client', refreshToken: 'refresh' });
  });
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:8.8.8.8',
    '2001:db8::1',
    'not-an-ip',
  ])('rejects non-public destination %s', (ip) =>
    expect(publicIp(ip)).toBe(false),
  );
  it('allows public addresses but requires exact hostname allowlist', () => {
    expect(publicIp('8.8.8.8')).toBe(true);
    vi.stubEnv('COMMUNICATION_SMTP_HOSTS', 'smtp.example.test');
    expect(() =>
      allowedHost('smtp.example.test', 'COMMUNICATION_SMTP_HOSTS'),
    ).not.toThrow();
    for (const host of [
      'localhost',
      '127.0.0.1',
      'smtp.example.test.evil.test',
      'SMTP.EXAMPLE.TEST',
    ])
      expect(() => allowedHost(host, 'COMMUNICATION_SMTP_HOSTS')).toThrow();
  });
  const smtp = {
    host: 'smtp.example.test',
    port: '587',
    secure: 'false',
    username: 'sender',
    fromName: 'Kalend',
    fromEmail: 'sender@example.test',
  };
  it('enforces SMTP TLS, ports, fields, and sender validation', () => {
    vi.stubEnv('COMMUNICATION_SMTP_HOSTS', 'smtp.example.test');
    expect(validateConfig('SMTP', smtp)).toMatchObject(smtp);
    expect(
      validateConfig('SMTP', { ...smtp, port: '465', secure: 'true' }).port,
    ).toBe('465');
    for (const change of [
      { port: '25' },
      { port: '465' },
      { secure: 'true' },
      { fromEmail: 'a@b\r\nBcc: x' },
      { fromName: 'a\r\nBcc:' },
      { tls: { rejectUnauthorized: false } },
      { host: 'localhost' },
    ])
      expect(() => validateConfig('SMTP', { ...smtp, ...change })).toThrow();
  });
  it('rejects Evolution URL credentials, private hosts, queries, paths and version drift', () => {
    vi.stubEnv('COMMUNICATION_EVOLUTION_HOSTS', 'evo.example.test');
    const c = {
      baseUrl: 'https://evolution-api.kalend.tech',
      instance: 'kalend',
      version: '2.3.7',
    };
    expect(validateConfig('EVOLUTION', c).instance).toBe('kalend');
    for (const baseUrl of [
      'http://evo.example.test',
      'https://evo.example.test/private',
      'https://user:pass@evo.example.test',
      'https://evo.example.test?key=secret',
      'https://evo.example.test:8443',
      'https://127.0.0.1',
    ])
      expect(() => validateConfig('EVOLUTION', { ...c, baseUrl })).toThrow();
    expect(() =>
      validateConfig('EVOLUTION', { ...c, instance: '../internal' }),
    ).toThrow();
    expect(() =>
      validateConfig('EVOLUTION', { ...c, version: 'unknown' }),
    ).toThrow();
  });
  it('validates and normalizes recipients without guessing a country code', () => {
    expect(email(' OWNER@EXAMPLE.TEST ')).toBe('owner@example.test');
    expect(phone('+55 (11) 99999-9999')).toBe('+5511999999999');
    for (const number of ['11999999999', '+0123456789', 'not-a-phone', null])
      expect(() => phone(number)).toThrow();
    expect(() => email('name <owner@example.test>')).toThrow();
  });
  it.each(EVENTS)('only exposes event variables for %s', (event) => {
    expect(() => renderText('{{passwordHash}}', event, {})).toThrow();
    expect(() => renderText('{{user.name}}', event, {})).toThrow();
    expect(renderText('{{nome}}', event, { nome: 'owner' })).toBe('owner');
    expect(variablesFor(event)).toContain('nome');
  });
  it('escapes all HTML and never recursively evaluates variable values', () => {
    const m = render(
      { subject: 'Olá {{nome}}', text: '{{empresa}}' },
      'EMAIL',
      'OWNER_WELCOME',
      { nome: '{{secret}}', empresa: '<img src=x onerror="bad">&' },
      'owner@example.test',
    );
    expect(m.subject).toBe('Olá {{secret}}');
    expect(m.html).toBe(
      '<p>&lt;img src=x onerror=&quot;bad&quot;&gt;&amp;</p>',
    );
    expect(() =>
      render(
        { subject: '{{nome}}', text: 'ok' },
        'EMAIL',
        'OWNER_WELCOME',
        { nome: 'x\r\nBcc:y' },
        'owner@example.test',
      ),
    ).toThrow();
    expect(() =>
      templateContent(
        { subject: 'x', text: '{{valor}}' },
        'EMAIL',
        'OWNER_WELCOME',
      ),
    ).toThrow();
    expect(() =>
      templateContent({ subject: 'x', text: 'x' }, 'WHATSAPP', 'OWNER_WELCOME'),
    ).toThrow();
  });
  it('keeps Meta parameters distinct from Evolution free text and disallows arbitrary object access', () => {
    const c = templateContent(
      { id: '123', name: 'welcome', language: 'pt_BR', parameters: ['nome'] },
      'WHATSAPP',
      'OWNER_WELCOME',
      'META',
    );
    expect(
      render(c, 'WHATSAPP', 'OWNER_WELCOME', { nome: 'A' }, '+5511999999999')
        .meta?.parameters,
    ).toEqual(['A']);
    expect(() =>
      templateContent(
        {
          id: '123',
          name: 'welcome',
          language: 'pt_BR',
          parameters: ['token'],
        },
        'WHATSAPP',
        'OWNER_WELCOME',
        'META',
      ),
    ).toThrow();
    expect(channels.META).toBe('WHATSAPP');
    expect(channels.EVOLUTION).toBe('WHATSAPP');
  });
  it('bounds retries and does not retry uncertain/auth/permanent/template/recipient failures', () => {
    const now = new Date(0);
    expect(retry('TRANSIENT', 1, now)?.getTime()).toBe(60000);
    expect(retry('RATE_LIMIT', 4, now)?.getTime()).toBe(480000);
    expect(retry('TRANSIENT', 5, now)).toBeNull();
    for (const kind of [
      'AUTH',
      'PERMANENT',
      'UNCERTAIN',
      'TEMPLATE',
      'RECIPIENT',
    ] as const)
      expect(retry(kind, 1, now)).toBeNull();
  });
  it('fails closed when Gmail/Push adapters are absent and requires an explicitly pinned Graph version', async () => {
    const registry = new CommunicationTransports();
    expect(registry.available('GMAIL')).toBe(false);
    expect(registry.available('PUSH_PENDING')).toBe(false);
    await expect(registry.get('GMAIL').verify({}, {})).rejects.toBeInstanceOf(
      TransportFailure,
    );
    vi.stubEnv('COMMUNICATION_META_GRAPH_VERSION', 'v25.0');
    expect(metaUrl({ graphVersion: 'v25.0' }, '123/messages').host).toBe(
      'graph.facebook.com',
    );
    expect(() => metaUrl({ graphVersion: 'v24.0' }, '123/messages')).toThrow();
    expect(() => metaUrl({ graphVersion: 'v25.0' }, '../me')).toThrow();
  });
});
