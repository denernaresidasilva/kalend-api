import {
  deliveryEnvironment,
  devSmtpSandboxReady,
  isDevEmailAllowed,
  isLegacyDevDeliveryEnvironment,
} from './dev-smtp-policy.js';

const dev = {
  EVOLUTION_WEBHOOK_BASE_URL: 'https://api-dev.kalend.tech',
  DATABASE_URL: 'postgresql://test:unused@localhost:5432/kalend_dev',
  COMMUNICATION_DEV_SMTP_SANDBOX_ENABLED: 'true',
  QA_COMMUNICATION_EMAIL_ALLOWLIST: 'qa@example.test, Owner+QA@example.test',
};

describe('DEV email isolation policy', () => {
  it('requires the explicit loopback sandbox and a valid allowlist', () => {
    expect(devSmtpSandboxReady(dev)).toBe(true);
    expect(
      devSmtpSandboxReady({
        ...dev,
        COMMUNICATION_DEV_SMTP_SANDBOX_ENABLED: 'false',
      }),
    ).toBe(false);
    expect(
      devSmtpSandboxReady({ ...dev, QA_COMMUNICATION_EMAIL_ALLOWLIST: '' }),
    ).toBe(false);
  });

  it('allows only exact normalized QA recipients in DEV', () => {
    expect(isDevEmailAllowed('qa@example.test', dev)).toBe(true);
    expect(isDevEmailAllowed(' OWNER+qa@example.test ', dev)).toBe(true);
    expect(isDevEmailAllowed('other@example.test', dev)).toBe(false);
    expect(
      isDevEmailAllowed('qa@example.test', {
        ...dev,
        COMMUNICATION_DEV_SMTP_SANDBOX_ENABLED: 'false',
      }),
    ).toBe(false);
  });

  it('does not change production recipient policy', () => {
    const production = {
      ...dev,
      EVOLUTION_WEBHOOK_BASE_URL: 'https://api.kalend.tech',
      DATABASE_URL: 'postgresql://test:unused@localhost:5432/kalend',
    };
    expect(isDevEmailAllowed('customer@example.test', production)).toBe(true);
    expect(devSmtpSandboxReady(production)).toBe(false);
  });

  it('stores DEV SMTP and Evolution deliveries as SANDBOX without changing Push', () => {
    expect(deliveryEnvironment('SMTP', 'PRODUCTION', dev)).toBe('SANDBOX');
    expect(deliveryEnvironment('EVOLUTION', 'PRODUCTION', dev)).toBe('SANDBOX');
    expect(deliveryEnvironment('PUSH_PENDING', 'SANDBOX', dev)).toBe('SANDBOX');
    expect(isLegacyDevDeliveryEnvironment('SMTP', 'PRODUCTION', dev)).toBe(
      true,
    );
    expect(
      isLegacyDevDeliveryEnvironment('PUSH_PENDING', 'PRODUCTION', dev),
    ).toBe(false);
  });
});
