import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { GatewaysService } from './gateways.service.js';

function serviceFixture(recurringEnabled = false) {
  let row: Record<string, unknown> = {
    gateway: 'PAGBANK',
    enabled: false,
    environment: 'SANDBOX',
    publicId: null,
    credentialsEncrypted: 'old-checkout-secret',
    webhookSecretEncrypted: null,
    recurringCredentialsEncrypted: 'old-recurring-secret',
    recurringEnabled,
    status: 'CONNECTED',
    lastValidatedAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  let writes = 0;
  const prisma = {
    $transaction: async (callback: (tx: unknown) => unknown) => callback(prisma),
    gatewayConfiguration: {
      findUnique: async () => row,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...row, ...data, updatedAt: new Date('2026-01-02T00:00:00Z') };
        writes++;
        return { count: 1 };
      },
      create: async () => { throw new Error('UNEXPECTED_CREATE'); },
    },
    payment: { count: async () => 0 },
  };
  const vault = {
    encrypt: (value: string, scope: string) => `encrypted:${scope}:${value}`,
    decrypt: (value: string) => value,
  };
  const registry = {
    get: () => ({
      capabilities: {
        checkout: true,
        recurring: true,
        nativeIdempotency: false,
        cancelAtPeriodEnd: false,
        webhookManagement: false,
      },
    }),
  };
  return {
    target: new GatewaysService(prisma as never, vault as never, registry as never),
    row: () => row,
    writes: () => writes,
  };
}

describe('GatewaysService PagBank environment changes', () => {
  it('allows checkout-only environment switch and clears old-environment recurring credentials', async () => {
    const f = serviceFixture();
    const result = await f.target.update('PAGBANK', {
      environment: 'PRODUCTION',
      credentials: 'new-checkout-secret',
      recurringCredentials: null,
      recurringEnabled: false,
    });

    expect(f.writes()).toBe(1);
    expect(f.row()).toMatchObject({
      environment: 'PRODUCTION',
      credentialsEncrypted: expect.stringContaining('new-checkout-secret'),
      recurringCredentialsEncrypted: null,
      recurringEnabled: false,
      enabled: false,
      status: 'PENDING_VALIDATION',
      lastValidatedAt: null,
    });
    expect(result).toMatchObject({
      environment: 'PRODUCTION',
      recurringConfigured: false,
      capabilities: { recurring: false },
    });
  });

  it('rejects enabling recurrence in a new environment without a new scoped credential', async () => {
    const f = serviceFixture(true);
    await expect(f.target.update('PAGBANK', {
      environment: 'PRODUCTION',
      credentials: 'new-checkout-secret',
      recurringCredentials: null,
      recurringEnabled: true,
    })).rejects.toThrow('PAGBANK_RECURRING_CONFIGURATION_REQUIRED');
    expect(f.writes()).toBe(0);
    expect(f.row().environment).toBe('SANDBOX');
  });

  it('rejects checkout-only configuration if the caller omits the credential reset field', async () => {
    const f = serviceFixture();
    await expect(f.target.update('PAGBANK', {
      environment: 'PRODUCTION',
      credentials: 'new-checkout-secret',
      recurringEnabled: false,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.writes()).toBe(0);
  });
});
