import { GoogleApi, GMAIL_SCOPE } from './google-api.js';
import { secureRequest } from './secure-http.js';
vi.mock('./secure-http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./secure-http.js')>()),
  secureRequest: vi.fn(),
}));
const request = vi.mocked(secureRequest);
const result = (status: number, body: unknown) => ({
  status,
  body: Buffer.from(JSON.stringify(body)),
});
beforeEach(() => request.mockReset());
describe('official Google HTTP contract', () => {
  it('exchanges code using form POST, official host and validates token response', async () => {
    request.mockResolvedValue(
      result(200, {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: GMAIL_SCOPE,
      }),
    );
    const tokens = await new GoogleApi().token({
      client_id: 'client',
      client_secret: 'secret',
      code: 'code',
      redirect_uri: 'https://api.example.test/communication/gmail/callback',
      grant_type: 'authorization_code',
    });
    expect(tokens.accessToken).toBe('access');
    const [url, method, headers, body] = request.mock.calls[0];
    expect(url.href).toBe('https://oauth2.googleapis.com/token');
    expect(url.search).toBe('');
    expect(method).toBe('POST');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(body!.toString()).get('client_secret')).toBe(
      'secret',
    );
  });
  it.each([
    [
      400,
      { error: 'invalid_grant', error_description: 'token PRIVATE' },
      'AUTH',
    ],
    [401, { error: 'invalid_client' }, 'AUTH'],
    [429, {}, 'RATE_LIMIT'],
    [503, {}, 'TRANSIENT'],
    [200, { access_token: 'x', expires_in: -1, token_type: 'Bearer' }, 'AUTH'],
    [
      200,
      { access_token: 'x', expires_in: 3600, token_type: 'Unknown' },
      'AUTH',
    ],
  ])(
    'classifies token HTTP %s and hides remote data',
    async (status, body, kind) => {
      request.mockResolvedValue(result(Number(status), body));
      await expect(
        new GoogleApi().token({
          grant_type: 'refresh_token',
          refresh_token: 'PRIVATE',
        }),
      ).rejects.toMatchObject({ kind, message: `COMMUNICATION_${kind}` });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it('gets verified account using Bearer, without requiring mailbox read scopes', async () => {
    request.mockResolvedValue(
      result(200, { email: 'sender@example.test', email_verified: true }),
    );
    expect(await new GoogleApi().account('access')).toBe('sender@example.test');
    const [url, method, headers] = request.mock.calls[0];
    expect(url.href).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect(method).toBe('GET');
    expect(headers.Authorization).toBe('Bearer access');
    request.mockResolvedValue(
      result(200, { email: 'sender@example.test', email_verified: false }),
    );
    await expect(new GoogleApi().account('access')).rejects.toThrow();
  });
  it('sends MIME as raw base64url in JSON to users/me/messages/send', async () => {
    request.mockResolvedValue(result(200, { id: 'message-id' }));
    expect(await new GoogleApi().send('access', 'cmF3')).toBe('message-id');
    const [url, method, headers, body] = request.mock.calls[0];
    expect(url.href).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    );
    expect(method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer access');
    expect(JSON.parse(body!.toString())).toEqual({ raw: 'cmF3' });
  });
  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [503, 'UNCERTAIN'],
    [400, 'PERMANENT'],
  ])('classifies send %s conservatively as %s', async (status, kind) => {
    request.mockResolvedValue(result(Number(status), { error: 'PRIVATE' }));
    await expect(new GoogleApi().send('access', 'raw')).rejects.toMatchObject({
      kind,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed success after send as uncertain', async () => {
    request.mockResolvedValue(result(200, {}));
    await expect(new GoogleApi().send('access', 'raw')).rejects.toMatchObject({
      kind: 'UNCERTAIN',
    });
  });
  it('revokes with form body and no token in query', async () => {
    request.mockResolvedValue(result(200, {}));
    await new GoogleApi().revoke('PRIVATE');
    const [url, method, headers, body] = request.mock.calls[0];
    expect(url.href).toBe('https://oauth2.googleapis.com/revoke');
    expect(method).toBe('POST');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(body!.toString()).toBe('token=PRIVATE');
  });
});

it.each(['rateLimitExceeded', 'userRateLimitExceeded'])(
  'classifies Gmail 403 %s as quota retry instead of revoking OAuth',
  async (reason) => {
    request.mockResolvedValue(result(403, { error: { errors: [{ reason }] } }));
    await expect(new GoogleApi().send('access', 'raw')).rejects.toMatchObject({
      kind: 'RATE_LIMIT',
    });
  },
);
