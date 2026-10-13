import { ForbiddenException } from '@nestjs/common';
import {
  allowedRecipient,
  assertQaScope,
  isQaCompany,
  qaCommunicationEnabled,
  qaRuntimeEnvironment,
  requireQaCommunicationAllowlist,
} from './qa-policy.js';
import { normalizeBrazilianPhone } from './recipient.js';

const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondCompanyId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pushId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const dev = {
  EVOLUTION_WEBHOOK_BASE_URL: 'https://api-dev.kalend.tech',
  DATABASE_URL: 'postgresql://qa:unused@localhost:5432/kalend_dev',
  QA_COMMUNICATION_ENABLED: 'true',
  QA_COMMUNICATION_COMPANY_IDS: `${companyId},${secondCompanyId}`,
  QA_COMMUNICATION_EMAIL_ALLOWLIST: 'qa@example.test, owner+qa@example.test',
  QA_COMMUNICATION_PHONE_ALLOWLIST: '12996015129,5512996015129',
  QA_COMMUNICATION_PUSH_SUBSCRIPTION_IDS: pushId,
};

describe('QA communication environment, company and recipient policy', () => {
  it('allows multiple configured companies in DEV without depending on slug/user id', () => {
    expect(qaRuntimeEnvironment(dev)).toBe('DEV');
    expect(qaCommunicationEnabled(dev)).toBe(true);
    const allowlist = requireQaCommunicationAllowlist(dev);
    expect(allowlist.companyIds).toEqual([companyId, secondCompanyId]);
    expect(isQaCompany(companyId, allowlist)).toBe(true);
    expect(isQaCompany('dddddddd-dddd-4ddd-8ddd-dddddddddddd', allowlist)).toBe(false);
    expect(() => assertQaScope(companyId, userId, allowlist)).not.toThrow();
    expect(() => assertQaScope(secondCompanyId, userId, allowlist)).not.toThrow();
    expect(() => assertQaScope('dddddddd-dddd-4ddd-8ddd-dddddddddddd', userId, allowlist)).toThrow(ForbiddenException);
  });

  it('rejects production and mismatched environments even with QA variables', () => {
    const production = {
      ...dev,
      EVOLUTION_WEBHOOK_BASE_URL: 'https://api.kalend.tech',
      DATABASE_URL: 'postgresql://qa:unused@localhost:5432/kalend',
    };
    expect(qaRuntimeEnvironment(production)).toBe('PRODUCTION');
    expect(qaCommunicationEnabled(production)).toBe(false);
    expect(() => requireQaCommunicationAllowlist(production)).toThrow(ForbiddenException);
    expect(qaCommunicationEnabled({ ...dev, QA_COMMUNICATION_ENABLED: 'false' })).toBe(false);
    expect(qaRuntimeEnvironment({ ...dev, DATABASE_URL: 'postgresql://qa:unused@localhost:5432/kalend' })).toBe('UNKNOWN');
  });

  it('fails closed when the company list is empty or invalid', () => {
    expect(() => requireQaCommunicationAllowlist({ ...dev, QA_COMMUNICATION_COMPANY_IDS: '' })).toThrow('QA_COMMUNICATION_SCOPE_NOT_CONFIGURED');
    expect(() => requireQaCommunicationAllowlist({ ...dev, QA_COMMUNICATION_COMPANY_IDS: 'not-a-uuid' })).toThrow('QA_COMMUNICATION_SCOPE_NOT_CONFIGURED');
    expect(() => requireQaCommunicationAllowlist({ ...dev, QA_COMMUNICATION_EMAIL_ALLOWLIST: 'not-an-email' })).toThrow('QA_COMMUNICATION_ALLOWLIST_INVALID');
  });

  it('allows only recipients in normalized allowlists and optional device list', () => {
    const allowlist = requireQaCommunicationAllowlist(dev);
    expect(allowedRecipient('EMAIL', 'owner+qa@example.test', 'USER', allowlist)).toBe(true);
    expect(allowedRecipient('EMAIL', 'other@example.test', 'USER', allowlist)).toBe(false);
    expect(allowedRecipient('WHATSAPP', '+5512996015129', 'USER', allowlist)).toBe(true);
    expect(allowedRecipient('WHATSAPP', '+5512988888888', 'USER', allowlist)).toBe(false);
    expect(allowedRecipient('PUSH', pushId, pushId, allowlist)).toBe(true);
    expect(allowedRecipient('PUSH', userId, userId, allowlist)).toBe(false);
  });
});

describe('Brazilian phone normalization', () => {
  it.each([
    ['12996015129', '+5512996015129'],
    ['5512996015129', '+5512996015129'],
    ['+5512996015129', '+5512996015129'],
    ['(12) 99601-5129', '+5512996015129'],
    ['12 99601-5129', '+5512996015129'],
    ['+55 12 99601-5129', '+5512996015129'],
  ])('%s normalizes to %s', (input, expected) => {
    expect(normalizeBrazilianPhone(input)).toBe(expected);
  });

  it('does not duplicate +55 and rejects invalid numbers without inventing digits', () => {
    expect(normalizeBrazilianPhone('555512996015129')).toBeUndefined();
    expect(normalizeBrazilianPhone('129601512')).toBeUndefined();
    expect(normalizeBrazilianPhone('')).toBeUndefined();
  });
});
