import { EventEmitter } from 'node:events';
import { secureRequest } from './secure-http.js';
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
  mocks.request.mockImplementation((_url, _options, callback) => {
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
    return req;
  });
}
describe('Gmail/Web Push hardened HTTP boundary', () => {
  it('pins public DNS with hostname TLS validation and forwards exact form/binary payload', async () => {
    respond(200, '{}');
    const body = Buffer.from([1, 2, 3]);
    await secureRequest(
      new URL('https://push.example.test/send/x'),
      'POST',
      { TTL: '300' },
      body,
    );
    const options = mocks.request.mock.calls[0][1];
    expect(options).toMatchObject({
      method: 'POST',
      agent: false,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      servername: 'push.example.test',
    });
    const cb = vi.fn();
    options.lookup('push.example.test', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    const req = mocks.request.mock.results[0].value;
    expect(req.end).toHaveBeenCalledWith(body);
  });
  it('rejects mixed public/private resolution and rebinding before socket creation', async () => {
    mocks.resolve6.mockResolvedValue(['::1']);
    await expect(
      secureRequest(new URL('https://push.example.test/x'), 'POST', {}),
    ).rejects.toMatchObject({ kind: 'PERMANENT' });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([
    'http://push.example.test/x',
    'https://user:secret@push.example.test/x',
    'https://push.example.test:8443/x',
    'https://push.example.test/x#fragment',
  ])('rejects unsafe URL %s', async (url) => {
    await expect(secureRequest(new URL(url), 'GET', {})).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('never follows redirects', async () => {
    respond(302, 'remote token');
    expect(
      (await secureRequest(new URL('https://push.example.test/x'), 'POST', {}))
        .status,
    ).toBe(302);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('bounds remote response size', async () => {
    respond(200, 'x'.repeat(65537));
    await expect(
      secureRequest(new URL('https://push.example.test/x'), 'POST', {}),
    ).rejects.toThrow();
  });
  it.each([false, true])(
    'times out and distinguishes pre-TLS vs potentially accepted POST connected=%s',
    async (connected) => {
      vi.useFakeTimers();
      const socket = new EventEmitter();
      const req = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        end: vi.fn(),
      });
      mocks.request.mockReturnValue(req);
      const pending = secureRequest(
        new URL('https://push.example.test/x'),
        'POST',
        {},
      );
      const assertion = expect(pending).rejects.toMatchObject({
        kind: connected ? 'UNCERTAIN' : 'TRANSIENT',
      });
      await vi.advanceTimersByTimeAsync(0);
      req.emit('socket', socket);
      if (connected) socket.emit('secureConnect');
      await vi.advanceTimersByTimeAsync(15001);
      await assertion;
      expect(req.destroy).toHaveBeenCalled();
    },
  );
});
