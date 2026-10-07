import { randomUUID } from 'node:crypto';
import type { EvolutionConnection } from '@prisma/client';
export function matches(
  row: Record<string, any>,
  where: Record<string, any>,
): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (key === 'AND') return value.every((part: any) => matches(row, part));
    if (value && typeof value === 'object' && !(value instanceof Date))
      return Object.entries(value).every(([op, target]: any) =>
        op === 'not'
          ? row[key] !== target
          : op === 'lt'
            ? row[key] != null && row[key] < target
            : op === 'lte'
              ? row[key] != null && row[key] <= target
              : op === 'gt'
                ? row[key] != null && row[key] > target
                : op === 'in'
                  ? target.includes(row[key])
                  : false,
      );
    return row[key] === value;
  });
}
/** Stateful persistence double: models context uniqueness and atomic lease claims; no real database. */
export function evolutionDatabase() {
  const rows = new Map<string, EvolutionConnection>();
  let provider: Record<string, any> | null = null;
  const find = (where: Record<string, any>) =>
    [...rows.values()].find((row) =>
      where.id
        ? row.id === where.id
        : where.globalKey
          ? row.globalKey === where.globalKey
          : row.companyId === where.companyId,
    ) ?? null;
  const model = {
    async upsert(this: void, { where, create }: any) {
      const existing = find(where);
      if (existing) return { ...existing };
      if (
        [...rows.values()].some(
          (row) => row.instanceName === create.instanceName,
        )
      )
        throw new Error('Unique instance');
      const row = {
        id: randomUUID(),
        companyId: null,
        globalKey: null,
        environment: null,
        version: 0,
        codeEncrypted: null,
        pairingPhoneEncrypted: null,
        attemptStartedAt: null,
        attemptExpiresAt: null,
        lastConnectionEventAt: null,
        disconnectReason: null,
        provisionRequested: false,
        provisionRetryAt: null,
        connectionRequested: false,
        codeFingerprint: null,
        codeExpiresAt: null,
        lastRecoveryAt: null,
        status: 'PENDING',
        prepared: false,
        pairingMethod: 'QR',
        phone: null,
        profileName: null,
        connectedAt: null,
        disconnectedAt: null,
        lastSeenAt: null,
        lastQrAt: null,
        lastError: null,
        webhookSecretEncrypted: null,
        lastWebhookAt: null,
        leaseId: null,
        leaseExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...create,
      } as EvolutionConnection;
      rows.set(row.id, row);
      return { ...row };
    },
    async findUnique(this: void, { where }: any) {
      const row = find(where);
      return row ? { ...row } : null;
    },
    async findUniqueOrThrow(this: void, { where }: any) {
      const row = find(where);
      if (!row) throw new Error('Missing row');
      return { ...row };
    },
    async findMany(this: void, { where = {}, take = 100 }: any) {
      return [...rows.values()]
        .filter((row) => matches(row, where))
        .slice(0, take)
        .map((row) => ({ ...row }));
    },
    async updateMany(this: void, { where, data }: any) {
      const selected = [...rows.values()].filter((row) => matches(row, where));
      for (const row of selected) {
        for (const [key, value] of Object.entries(data)) {
          (row as any)[key] =
            value && typeof value === 'object' && 'increment' in value
              ? ((row as any)[key] ?? 0) + (value as any).increment
              : value;
        }
      }
      return { count: selected.length };
    },
  };
  const providers = {
    async findUnique() {
      return provider;
    },
    async findMany() {
      return provider ? [provider] : [];
    },
    async upsert(this: void, { create, update }: any) {
      provider = provider
        ? { ...provider, ...update }
        : { revision: 1, ...create };
      return provider;
    },
    async update({ data }: any) {
      if (!provider) throw new Error('Missing provider');
      provider = { ...provider, ...data };
      return provider;
    },
  };
  return {
    rows,
    db: {
      async $transaction(operation: any) {
        return operation(this);
      },
      evolutionConnection: model,
      globalCommunicationProvider: providers,
      user: {
        async findFirst({ where }: any) {
          return ['admin', 'owner-a', 'owner-b'].includes(where.id)
            ? { phone: '+5511999999999' }
            : null;
        },
      },
    },
    reset() {
      rows.clear();
      provider = null;
    },
    setLegacy(name: string) {
      provider = {
        config: { instance: name },
        provider: 'EVOLUTION',
        revision: 1,
      };
    },
  };
}
