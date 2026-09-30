import type { Request } from 'express';

// Deliberately omit all header values, including user-agent: callers can put
// credentials in any header. rawHeaders is alternating names and values.
export function pagbankWebhookDiagnostics(req: Request) {
  const names = Object.keys(req.headers);
  const rawNames = req.rawHeaders.filter((_, index) => index % 2 === 0);
  const signature = req.headers['x-payload-signature'];
  const lengths = (Array.isArray(signature) ? signature : [signature ?? ''])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.length);
  const rawLengths: number[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'x-payload-signature')
      rawLengths.push(req.rawHeaders[index + 1].length);
  }
  return {
    method: 'POST',
    path: '/webhooks/pagbank',
    headerNames: names,
    rawHeaderNames: rawNames,
    productOriginPresent: names.includes('x-product-origin'),
    signaturePresent: names.includes('x-payload-signature'),
    signatureValueCount: lengths.length,
    signatureValueLengths: lengths,
    rawSignaturePresent: rawLengths.length > 0,
    rawSignatureValueCount: rawLengths.length,
    rawSignatureValueLengths: rawLengths,
  };
}
