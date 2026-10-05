import { vi } from 'vitest';

// Stateful persistence double for HTTP tests; SQL/FK invariants are tested separately.
export function pushStore() {
  const devices: Record<string, any>[] = [],
    grants: Record<string, any>[] = [];
  function match(row: Record<string, any>, where: Record<string, any>) {
    for (const field of [
      'id',
      'endpointHash',
      'userId',
      'scope',
      'provider',
      'environment',
      'active',
      'revokedAt',
    ]) {
      if (where[field] !== undefined && row[field] !== where[field])
        return false;
    }
    if (
      typeof where.credentialsEncrypted === 'string' &&
      row.credentialsEncrypted !== where.credentialsEncrypted
    )
      return false;
    if (where.credentialsEncrypted?.not === null && !row.credentialsEncrypted)
      return false;
    if (where.OR && row.expiresAt && row.expiresAt <= new Date()) return false;
    if (
      where.expiresAt?.lte &&
      (!row.expiresAt || row.expiresAt > where.expiresAt.lte)
    )
      return false;
    if (
      where.authorizations &&
      !grants.some(
        (g) =>
          g.subscriptionId === row.id &&
          Object.entries(where.authorizations.some).every(
            ([key, value]) => key === 'membership' || g[key] === value,
          ),
      )
    )
      return false;
    return true;
  }
  function view(row: Record<string, any>, select?: Record<string, any>) {
    if (!select) return { ...row };
    return Object.fromEntries(
      Object.entries(select).map(([key, value]) => [
        key,
        key === 'authorizations'
          ? grants
              .filter(
                (g) =>
                  g.subscriptionId === row.id &&
                  g.companyId === value.where.companyId &&
                  g.userId === value.where.userId,
              )
              .map((g) => ({ active: g.active, revokedAt: g.revokedAt }))
          : row[key],
      ]),
    );
  }
  const db = {
    globalPushSubscription: {
      findUnique: vi.fn(
        async ({ where }) =>
          devices.find((d) => d.endpointHash === where.endpointHash) ?? null,
      ),
      findFirst: vi.fn(async ({ where, select }) => {
        const row = devices.find((d) => match(d, where));
        return row ? view(row, select) : null;
      }),
      findMany: vi.fn(async ({ where, select, take }) =>
        devices
          .filter((d) => match(d, where))
          .slice(0, take ?? 100)
          .map((d) => view(d, select)),
      ),
      count: vi.fn(
        async ({ where }) => devices.filter((d) => match(d, where)).length,
      ),
      upsert: vi.fn(async ({ where, create, update, select }) => {
        let row = devices.find((d) => d.endpointHash === where.endpointHash);
        if (!row) {
          row = {
            scope: 'GLOBAL',
            provider: 'WEB_PUSH',
            platform: 'WEB',
            createdAt: new Date(),
            updatedAt: new Date(),
            revokedAt: null,
            ...create,
          };
          devices.push(row!);
        } else Object.assign(row, update, { updatedAt: new Date() });
        return view(row!, select);
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const rows = devices.filter((d) => match(d, where));
        rows.forEach((d) => Object.assign(d, data));
        return { count: rows.length };
      }),
    },
    globalPushAuthorization: {
      upsert: vi.fn(async ({ where, create, update }) => {
        let row = grants.find(
          (g) =>
            g.subscriptionId ===
              where.subscriptionId_companyId.subscriptionId &&
            g.companyId === where.subscriptionId_companyId.companyId,
        );
        if (row) Object.assign(row, update);
        else {
          row = { active: true, revokedAt: null, ...create };
          grants.push(row!);
        }
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const rows = grants.filter((g) =>
          Object.entries(where).every(([key, value]) => g[key] === value),
        );
        rows.forEach((g) => Object.assign(g, data));
        return { count: rows.length };
      }),
    },
  };
  return {
    db,
    devices,
    grants,
    reset() {
      devices.length = 0;
      grants.length = 0;
    },
  };
}
