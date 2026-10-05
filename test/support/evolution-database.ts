import { randomUUID } from 'node:crypto';
import type { EvolutionConnection } from '@prisma/client';
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
    async upsert({ where, create }: any) {
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
    async findUnique({ where }: any) {
      const row = find(where);
      return row ? { ...row } : null;
    },
    async findUniqueOrThrow({ where }: any) {
      const row = find(where);
      if (!row) throw new Error('Missing row');
      return { ...row };
    },
    async updateMany({ where, data }: any) {
      const row = find(where);
      if (!row) return { count: 0 };
      if (where.OR && row.leaseId && row.leaseExpiresAt! >= new Date())
        return { count: 0 };
      if (where.leaseId && row.leaseId !== where.leaseId) return { count: 0 };
      if (
        where.leaseExpiresAt?.gt &&
        row.leaseExpiresAt! <= where.leaseExpiresAt.gt
      )
        return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  const providers = {
    async findUnique() {
      return provider;
    },
    async findMany() {
      return provider ? [provider] : [];
    },
    async upsert({ create, update }: any) {
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
