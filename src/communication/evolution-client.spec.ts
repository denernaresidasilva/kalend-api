import {
  EvolutionClient,
  EvolutionFailure,
  evolutionPhone,
  evolutionQr,
} from './evolution-client.js';
import { secureRequest } from './secure-http.js';
vi.mock('./secure-http.js', () => ({ secureRequest: vi.fn() }));
const http = vi.mocked(secureRequest);
const png = 'data:image/png;base64,iVBORw0KGgo=';
describe('Evolution 2.3.7 client', () => {
  beforeEach(() => {
    vi.stubEnv('EVOLUTION_API_KEY', 'unit-only-secret');
    http.mockReset();
    http.mockResolvedValue({ status: 200, body: Buffer.from('{}') });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('uses official routes, methods and backend-only credentials', async () => {
    const client = new EvolutionClient();
    await client.createInstance('kalend_a');
    http.mockResolvedValueOnce({
      status: 200,
      body: Buffer.from('[{"name":"kalend_a"}]'),
    });
    expect(await client.fetchInstances('kalend_a')).toMatchObject({
      name: 'kalend_a',
    });
    await client.connectInstance('kalend_a', '+5511999999999');
    await client.fetchConnectionState('kalend_a');
    await client.restartInstance('kalend_a');
    await client.logoutInstance('kalend_a');
    await client.deleteInstance('kalend_a');
    await client.setWebhook(
      'kalend_a',
      'https://api.example.test/webhook',
      'separate-token',
    );
    expect(
      http.mock.calls.map(([url, method]) => [
        url.pathname + url.search,
        method,
      ]),
    ).toEqual([
      ['/instance/create', 'POST'],
      ['/instance/fetchInstances?instanceName=kalend_a', 'GET'],
      ['/instance/connect/kalend_a?number=5511999999999', 'GET'],
      ['/instance/connectionState/kalend_a', 'GET'],
      ['/instance/restart/kalend_a', 'POST'],
      ['/instance/logout/kalend_a', 'DELETE'],
      ['/instance/delete/kalend_a', 'DELETE'],
      ['/webhook/set/kalend_a', 'POST'],
    ]);
    expect(
      http.mock.calls.every(
        ([url, , headers]) =>
          url.origin === 'https://evolution-api.kalend.tech' &&
          headers.apikey === 'unit-only-secret',
      ),
    ).toBe(true);
    expect(
      JSON.parse(http.mock.calls[7][3]!.toString()).webhook.headers,
    ).toEqual({ 'x-kalend-evolution-token': 'separate-token' });
  });
  it('handles the real 404 fetchInstances contract', async () => {
    http.mockResolvedValue({
      status: 404,
      body: Buffer.from('{"message":"private"}'),
    });
    expect(await new EvolutionClient().fetchInstances('kalend_a')).toBeNull();
  });
  it.each([
    [401, 'EVOLUTION_AUTH_FAILED'],
    [403, 'EVOLUTION_AUTH_FAILED'],
    [500, 'EVOLUTION_UNAVAILABLE'],
    [429, 'EVOLUTION_UNAVAILABLE'],
    [400, 'CONNECTION_FAILED'],
  ])('sanitizes remote HTTP %s', async (status, code) => {
    http.mockResolvedValue({
      status: status as number,
      body: Buffer.from('unit-only-secret private stack'),
    });
    await expect(
      new EvolutionClient().connectInstance('kalend_a'),
    ).rejects.toThrow(code as string);
  });
  it('sanitizes network failures and Evolution 200 error bodies', async () => {
    http.mockRejectedValueOnce(new Error('unit-only-secret'));
    await expect(
      new EvolutionClient().connectInstance('kalend_a'),
    ).rejects.toThrow('EVOLUTION_UNAVAILABLE');
    http.mockResolvedValueOnce({
      status: 200,
      body: Buffer.from('{"error":true,"message":"unit-only-secret"}'),
    });
    await expect(
      new EvolutionClient().connectInstance('kalend_a'),
    ).rejects.toThrow('CONNECTION_FAILED');
  });
  it('prepares text sending with acceptance distinct from delivery', async () => {
    http.mockResolvedValue({
      status: 200,
      body: Buffer.from('{"key":{"id":"message_1"},"hash":"private"}'),
    });
    expect(
      await new EvolutionClient().sendTextMessage(
        'kalend_a',
        '+5511999999999',
        'Olá',
      ),
    ).toEqual({ accepted: true, messageId: 'message_1' });
    expect(JSON.parse(http.mock.calls[0][3]!.toString())).toEqual({
      number: '5511999999999',
      text: 'Olá',
      linkPreview: false,
    });
  });
  it('validates QR signature and international phone numbers', () => {
    expect(evolutionQr(png)).toBe(png);
    expect(evolutionQr('data:image/png;base64,YWJj')).toBeNull();
    expect(evolutionQr('https://private.example/qr')).toBeNull();
    expect(evolutionPhone('+5511999999999')).toBe('5511999999999');
    expect(evolutionPhone('+55 (12) 99605-5129')).toBe('5512996055129');
    expect(() => evolutionPhone('11999 test')).toThrow(EvolutionFailure);
  });
});
