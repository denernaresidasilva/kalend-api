import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
export const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
export const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
export const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
export const OTHER_COMPANY_ID = '44444444-4444-4444-8444-444444444444';
type User = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  isActive: boolean;
  isSuperAdmin: boolean;
};
type Session = {
  credentialHash: string;
  id: string;
  userId: string;
  selectedCompanyId: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  refreshExpiresAt: Date;
  revokedAt: Date | null;
};
type Refresh = {
  id: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
};
// Stateful test double. Does NOT claim to emulate PostgreSQL transactions/concurrency.
export function authDatabase(passwordHash: string) {
  const users: User[] = [
    {
      id: ADMIN_ID,
      email: 'admin@example.test',
      name: 'Admin',
      passwordHash,
      isActive: true,
      isSuperAdmin: true,
    },
    {
      id: MEMBER_ID,
      email: 'member@example.test',
      name: 'Member',
      passwordHash,
      isActive: true,
      isSuperAdmin: false,
    },
  ];
  const sessions: Session[] = [];
  const refreshes: Refresh[] = [];
  const counters = new Map<string, number>();
  const memberships = [
    {
      id: randomUUID(),
      userId: MEMBER_ID,
      companyId: COMPANY_ID,
      role: 'OWNER',
      isActive: true,
      company: {
        id: COMPANY_ID,
        name: 'Empresa',
        slug: 'empresa',
        status: 'ACTIVE',
        isActive: true,
      },
    },
    {
      id: randomUUID(),
      userId: MEMBER_ID,
      companyId: OTHER_COMPANY_ID,
      role: 'PROFESSIONAL',
      isActive: true,
      company: {
        id: OTHER_COMPANY_ID,
        name: 'Outra',
        slug: 'outra',
        status: 'TRIAL',
        isActive: true,
      },
    },
  ];
  const authUser = (user: User) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    isActive: user.isActive,
    isSuperAdmin: user.isSuperAdmin,
    passwordHash: user.passwordHash,
  });
  const db = {
    user: {
      findUnique: vi.fn(
        async ({ where }) => users.find((u) => u.email === where.email) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }) =>
          users.find(
            (u) =>
              u.id === where.id &&
              u.isActive &&
              u.passwordHash === where.passwordHash,
          ) ?? null,
      ),
    },
    authSession: {
      create: vi.fn(async ({ data }) => {
        const session: Session = {
          id: randomUUID(),
          userId: data.userId,
          credentialHash: data.credentialHash,
          selectedCompanyId: null,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          expiresAt: data.expiresAt,
          refreshExpiresAt: data.refreshExpiresAt,
          revokedAt: null,
        };
        sessions.push(session);
        refreshes.push({
          id: randomUUID(),
          sessionId: session.id,
          tokenHash: data.refreshTokens.create.tokenHash,
          expiresAt: data.refreshTokens.create.expiresAt,
          usedAt: null,
        });
        return { ...session };
      }),
      findUnique: vi.fn(async ({ where }) => {
        const s = sessions.find((s) => s.id === where.id);
        return s
          ? { ...s, user: authUser(users.find((u) => u.id === s.userId)!) }
          : null;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0;
        for (const s of sessions) {
          if (
            (where.id && s.id !== where.id) ||
            (where.userId && s.userId !== where.userId) ||
            (where.revokedAt === null && s.revokedAt !== null) ||
            (where.expiresAt && s.expiresAt <= where.expiresAt.gt) ||
            (where.refreshExpiresAt &&
              s.refreshExpiresAt <= where.refreshExpiresAt.gt)
          )
            continue;
          Object.assign(s, data);
          count++;
        }
        return { count };
      }),
    },
    authRefreshToken: {
      findUnique: vi.fn(async ({ where }) => {
        const t = refreshes.find((t) => t.tokenHash === where.tokenHash);
        if (!t) return null;
        const s = sessions.find((s) => s.id === t.sessionId)!;
        return {
          ...t,
          session: {
            ...s,
            user: authUser(users.find((u) => u.id === s.userId)!),
          },
        };
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const t = refreshes.find((t) => t.id === where.id && t.usedAt === null);
        if (!t) return { count: 0 };
        Object.assign(t, data);
        return { count: 1 };
      }),
      create: vi.fn(async ({ data }) => {
        const t = { ...data, id: randomUUID(), usedAt: null };
        refreshes.push(t);
        return { ...t };
      }),
    },
    membership: {
      findMany: vi.fn(async ({ where }) =>
        memberships.filter((m) => m.userId === where.userId && m.isActive),
      ),
      findUnique: vi.fn(
        async ({ where }) =>
          memberships.find(
            (m) =>
              m.userId === where.userId_companyId.userId &&
              m.companyId === where.userId_companyId.companyId,
          ) ?? null,
      ),
    },
    authRateLimit: {
      upsert: vi.fn(async ({ where }) => {
        const attempts = (counters.get(where.key) ?? 0) + 1;
        counters.set(where.key, attempts);
        return { attempts };
      }),
    },
    gatewayConfiguration: { findUnique: vi.fn(async () => null) },
    plan: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  function reset() {
    sessions.length = 0;
    refreshes.length = 0;
    counters.clear();
    for (const u of users) {
      u.isActive = true;
      u.passwordHash = passwordHash;
      u.isSuperAdmin = u.id === ADMIN_ID;
    }
    for (const m of memberships) {
      m.isActive = true;
      m.company.isActive = true;
    }
  }
  return { db, users, sessions, refreshes, counters, memberships, reset };
}
