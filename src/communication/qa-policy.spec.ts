import { ForbiddenException } from '@nestjs/common';
import {
  allowedRecipient,
  assertQaScope,
  qaCommunicationEnabled,
  qaRuntimeEnvironment,
  requireQaCommunicationAllowlist,
} from './qa-policy.js';

const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pushId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const dev = {
  EVOLUTION_WEBHOOK_BASE_URL: 'https://api-dev.kalend.tech',
  DATABASE_URL: 'postgresql://qa:unused@localhost:5432/kalend_dev',
  QA_COMMUNICATION_ENABLED: 'true',
  QA_COMMUNICATION_COMPANY_ID: companyId,
  QA_COMMUNICATION_USER_ID: userId,
  QA_COMMUNICATION_ALLOWED_WHATSAPP: '+15551234567',
  QA_COMMUNICATION_ALLOWED_EMAIL: 'qa@example.test',
  QA_COMMUNICATION_ALLOWED_PUSH_SUBSCRIPTION_ID: pushId,
};

describe('QA communication environment and allowlist policy', () => {
  it('allows a fully configured DEV environment only', () => {
    expect(qaRuntimeEnvironment(dev)).toBe('DEV');
    expect(qaCommunicationEnabled(dev)).toBe(true);
    expect(requireQaCommunicationAllowlist(dev)).toMatchObject({
      companyId,
      userId,
      whatsapp: '+15551234567',
      email: 'qa@example.test',
      pushSubscriptionId: pushId,
    });
  });

  it('rejects a production origin even if every QA flag is set', () => {
    const production = {
      ...dev,
      EVOLUTION_WEBHOOK_BASE_URL: 'https://api.kalend.tech',
      DATABASE_URL: 'postgresql://qa:unused@localhost:5432/kalend',
    };
    expect(qaRuntimeEnvironment(production)).toBe('PRODUCTION');
    expect(qaCommunicationEnabled(production)).toBe(false);
    expect(() => requireQaCommunicationAllowlist(production)).toThrow(
      ForbiddenException,
    );
  });

  it('fails closed for origin/database mismatches and missing flags', () => {
    expect(
      qaRuntimeEnvironment({
        ...dev,
        DATABASE_URL: 'postgresql://qa:unused@localhost:5432/kalend',
      }),
    ).toBe('UNKNOWN');
    expect(
      qaCommunicationEnabled({ ...dev, QA_COMMUNICATION_ENABLED: 'false' }),
    ).toBe(false);
    expect(() =>
      requireQaCommunicationAllowlist({ ...dev, QA_COMMUNICATION_USER_ID: '' }),
    ).toThrow(ForbiddenException);
  });

  it('rejects wrong company/user and recipient for every channel', () => {
    const allowlist = requireQaCommunicationAllowlist(dev);
    expect(() => assertQaScope(companyId, userId, allowlist)).not.toThrow();
    expect(() => assertQaScope(companyId, pushId, allowlist)).toThrow(
      ForbiddenException,
    );
    expect(
      allowedRecipient('EMAIL', 'qa@example.test', 'USER', allowlist),
    ).toBe(true);
    expect(
      allowedRecipient('EMAIL', 'other@example.test', 'USER', allowlist),
    ).toBe(false);
    expect(
      allowedRecipient('WHATSAPP', '+15551234567', 'USER', allowlist),
    ).toBe(true);
    expect(
      allowedRecipient('WHATSAPP', '+15557654321', 'USER', allowlist),
    ).toBe(false);
    expect(allowedRecipient('PUSH', pushId, pushId, allowlist)).toBe(true);
    expect(allowedRecipient('PUSH', pushId, userId, allowlist)).toBe(false);
  });
});
