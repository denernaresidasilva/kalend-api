import type { Request } from 'express';
import { pagbankWebhookDiagnostics } from './pagbank-webhook-diagnostics.js';

it('compares normalized and raw names without exposing any header or body values', () => {
  const req = {
    headers: {
      authorization: 'Bearer secret-auth',
      cookie: 'secret-cookie',
      'set-cookie': 'secret-set-cookie',
      'x-product-origin': 'secret-origin',
      'content-type': 'secret-content-type',
      'user-agent': 'secret-agent',
      'x-authenticity-token': 'secret-legacy',
      'x-payload-signature': ['  , ', ''],
    },
    rawHeaders: [
      'Authorization',
      'Bearer secret-auth',
      'X-Payload-Signature',
      'secret-signature',
    ],
    body: { secret: 'secret-payload' },
    rawBody: Buffer.from('secret-body'),
    url: '/webhooks/pagbank?secret-query',
  } as unknown as Request;
  const result = pagbankWebhookDiagnostics(req);
  expect(result).toMatchObject({
    signaturePresent: true,
    signatureValueCount: 0,
    rawSignaturePresent: true,
    rawSignatureValueCount: 1,
    rawSignatureValueLengths: [16],
    productOriginPresent: true,
  });
  expect(result.rawHeaderNames).toEqual([
    'Authorization',
    'X-Payload-Signature',
  ]);
  expect(JSON.stringify(result)).not.toContain('secret-');
});

it.each(['abc, de', ['abc', 'de']])(
  'records only lengths for string/array signatures %j',
  (signature) => {
    const result = pagbankWebhookDiagnostics({
      headers: { 'x-payload-signature': signature },
      rawHeaders: ['X-Payload-Signature', 'abc', 'x-payload-signature', 'de'],
    } as unknown as Request);
    expect(result.signatureValueLengths).toEqual([3, 2]);
    expect(result.rawSignatureValueLengths).toEqual([3, 2]);
  },
);
