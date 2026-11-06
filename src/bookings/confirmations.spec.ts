import { confirmationToken } from './confirmations.service.js';
import {
  depositAmount,
  UnavailableMerchantDepositProvider,
} from './deposit-contract.js';
it('hashes only high-entropy confirmation tokens and rejects malformed values', () => {
  expect(confirmationToken('a'.repeat(43))).toHaveLength(64);
  for (const value of ['a'.repeat(42), '../unsafe', null, {}, 'a'.repeat(44)])
    expect(() => confirmationToken(value)).toThrow();
});
it('calculates deposit cents without float rounding, caps fixed values and refuses ambiguous or unsafe rules', async () => {
  expect(depositAmount(35000, { percentBps: null, fixedCents: 5000 })).toBe(
    5000,
  );
  expect(depositAmount(3333, { percentBps: 2500, fixedCents: null })).toBe(833);
  expect(depositAmount(3000, { percentBps: null, fixedCents: 5000 })).toBe(
    3000,
  );
  for (const rule of [
    { percentBps: null, fixedCents: null },
    { percentBps: 10001, fixedCents: null },
    { percentBps: 100, fixedCents: 100 },
  ])
    expect(() => depositAmount(3000, rule)).toThrow();
  const provider = new UnavailableMerchantDepositProvider();
  await expect(
    provider.create({
      companyId: 'qa',
      bookingRequestId: 'qa',
      idempotencyKey: 'qa',
      amountCents: 100,
      currency: 'BRL',
    }),
  ).rejects.toThrow('MERCHANT_GATEWAY_NOT_HOMOLOGATED');
});
import { confirmationLink, operationalPushPath } from './confirmation-link.js';
it('limits push actions to exact local confirmation/opportunity paths without open redirects', () => {
  const path = '/confirmar-agendamento?token=' + 'A'.repeat(43);
  expect(
    confirmationLink({ url_confirmacao: 'https://dev.kalend.tech' + path }),
  ).toBe(path);
  expect(operationalPushPath(path)).toBe(path);
  for (const value of [
    path + '&redirect=//evil.test',
    '//evil.test',
    path + '#x',
    '/auth/login?token=secret',
  ])
    expect(operationalPushPath(value)).toBeNull();
});
