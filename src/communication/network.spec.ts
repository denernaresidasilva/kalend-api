import { EventEmitter } from 'node:events';
import { jsonRequest, resolvePublic } from './network.js';
const mocks = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  request: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    resolve4 = mocks.resolve4;
    resolve6 = mocks.resolve6;
  },
}));
vi.mock('node:https', () => ({ request: mocks.request }));
beforeEach(() => {
  mocks.resolve4.mockResolvedValue(['8.8.8.8']);
  mocks.resolve6.mockResolvedValue([]);
});
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
function respond(status: number, body: string) {
  mocks.request.mockImplementation((_url, options, callback) => {
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(() => {
        const res = Object.assign(new EventEmitter(), { statusCode: status });
        callback(res);
        res.emit('data', Buffer.from(body));
        res.emit('end');
        req.emit('close');
      }),
    });
    expect(options.rejectUnauthorized).toBe(true);
    return req;
  });
}
describe('network boundary', () => {
  it('rejects mixed public/private DNS responses before creating a socket', async () => {
    mocks.resolve6.mockResolvedValue(['::1']);
    await expect(
      jsonRequest(new URL('https://evo.example.test/'), {}),
    ).rejects.toMatchObject({ kind: 'PERMANENT' });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('rejects DNS failure and loopback rebinding on the next request', async () => {
    mocks.resolve4
      .mockResolvedValueOnce(['8.8.8.8'])
      .mockResolvedValueOnce(['127.0.0.1']);
    expect(await resolvePublic('evo.example.test')).toBe('8.8.8.8');
    await expect(resolvePublic('evo.example.test')).rejects.toThrow();
  });
  it('pins the resolved IP and preserves TLS hostname', async () => {
    respond(200, '{"ok":true}');
    expect(
      await jsonRequest(new URL('https://evo.example.test/test'), {}),
    ).toEqual({ ok: true });
    const options = mocks.request.mock.calls[0][1];
    const callback = vi.fn();
    options.lookup('evo.example.test', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(options.servername).toBe('evo.example.test');
    expect(options.family).toBe(4);
    expect(options.agent).toBe(false);
  });
  it.each([
    [302, 'PERMANENT'],
    [401, 'AUTH'],
    [403, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [503, 'UNCERTAIN'],
  ])(
    'does not follow redirects or leak error bodies (%s)',
    async (status, kind) => {
      respond(status as number, '{"token":"secret"}');
      await expect(
        jsonRequest(new URL('https://evo.example.test/test'), {}),
      ).rejects.toMatchObject({ kind, message: `COMMUNICATION_${kind}` });
      expect(mocks.request).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds response size', async () => {
    respond(200, 'x'.repeat(262145));
    await expect(
      jsonRequest(new URL('https://evo.example.test/test'), {}),
    ).rejects.toMatchObject({ kind: 'UNCERTAIN' });
  });
  it('terminates a hung provider request', async () => {
    vi.useFakeTimers();
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(),
    });
    mocks.request.mockReturnValue(req);
    const result = expect(
      jsonRequest(new URL('https://evo.example.test/'), {}),
    ).rejects.toMatchObject({ kind: 'UNCERTAIN' });
    await vi.advanceTimersByTimeAsync(15001);
    await result;
    expect(req.destroy).toHaveBeenCalled();
  });
});
