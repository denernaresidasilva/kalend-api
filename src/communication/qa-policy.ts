import { ForbiddenException } from '@nestjs/common';

export const QA_COMMUNICATION_EVENT = 'QA_COMMUNICATION_TEST' as const;
export const QA_COMPANY_SLUG = 'qa-communication-dev';
export type QaChannel = 'EMAIL' | 'WHATSAPP' | 'PUSH';
export type QaEnvironment = 'DEV' | 'STAGING';

export type QaCommunicationAllowlist = {
  environment: QaEnvironment;
  companyId: string;
  userId: string;
  whatsapp?: string;
  email?: string;
  pushSubscriptionId?: string;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Classify from server-side URL + database identity, never from request data or NODE_ENV. */
export function qaRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): QaEnvironment | 'PRODUCTION' | 'UNKNOWN' {
  try {
    const api = new URL(env.EVOLUTION_WEBHOOK_BASE_URL ?? '');
    const db = new URL(env.DATABASE_URL ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(db.protocol) ||
      api.username ||
      api.password ||
      api.pathname !== '/' ||
      api.search ||
      api.hash
    )
      return 'UNKNOWN';
    const apiOrigin = api.origin;
    const dbName = decodeURIComponent(db.pathname.slice(1));
    const billing = env.BILLING_PUBLIC_API_URL;
    if (billing && new URL(billing).origin !== apiOrigin) return 'UNKNOWN';
    if (apiOrigin === 'https://api-dev.kalend.tech' && dbName === 'kalend_dev')
      return 'DEV';
    if (
      apiOrigin === 'https://api-staging.kalend.tech' &&
      dbName === 'kalend_staging'
    )
      return 'STAGING';
    if (
      apiOrigin === 'https://api.kalend.tech' &&
      dbName !== 'kalend_dev' &&
      dbName !== 'kalend_staging'
    )
      return 'PRODUCTION';
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

export function qaCommunicationEnabled(env: NodeJS.ProcessEnv = process.env) {
  const environment = qaRuntimeEnvironment(env);
  return (
    env.QA_COMMUNICATION_ENABLED === 'true' &&
    (environment === 'DEV' || environment === 'STAGING')
  );
}

export function requireQaCommunicationAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): QaCommunicationAllowlist {
  const environment = qaRuntimeEnvironment(env);
  if (
    env.QA_COMMUNICATION_ENABLED !== 'true' ||
    (environment !== 'DEV' && environment !== 'STAGING')
  )
    throw new ForbiddenException('QA_COMMUNICATION_DISABLED');

  const companyId = env.QA_COMMUNICATION_COMPANY_ID ?? '';
  const userId = env.QA_COMMUNICATION_USER_ID ?? '';
  if (!uuidPattern.test(companyId) || !uuidPattern.test(userId))
    throw new ForbiddenException('QA_COMMUNICATION_SCOPE_NOT_CONFIGURED');

  const whatsapp = normalizeQaPhone(env.QA_COMMUNICATION_ALLOWED_WHATSAPP);
  const email = normalizeQaEmail(env.QA_COMMUNICATION_ALLOWED_EMAIL);
  const pushSubscriptionId = normalizeQaSubscription(
    env.QA_COMMUNICATION_ALLOWED_PUSH_SUBSCRIPTION_ID,
  );
  return {
    environment,
    companyId,
    userId,
    ...(whatsapp ? { whatsapp } : {}),
    ...(email ? { email } : {}),
    ...(pushSubscriptionId ? { pushSubscriptionId } : {}),
  };
}

export function allowedRecipient(
  channel: QaChannel,
  recipient: string,
  targetKey: string,
  allowlist: QaCommunicationAllowlist,
) {
  if (channel === 'WHATSAPP')
    return (
      !!allowlist.whatsapp && normalizeQaPhone(recipient) === allowlist.whatsapp
    );
  if (channel === 'EMAIL')
    return !!allowlist.email && normalizeQaEmail(recipient) === allowlist.email;
  return (
    !!allowlist.pushSubscriptionId &&
    targetKey === allowlist.pushSubscriptionId &&
    recipient === allowlist.pushSubscriptionId
  );
}

export function allowlistedRecipient(
  channel: QaChannel,
  allowlist: QaCommunicationAllowlist,
) {
  if (channel === 'WHATSAPP') return allowlist.whatsapp ?? null;
  if (channel === 'EMAIL') return allowlist.email ?? null;
  return allowlist.pushSubscriptionId ?? null;
}

export function assertQaScope(
  companyId: string,
  userId: string,
  allowlist: QaCommunicationAllowlist,
) {
  if (companyId !== allowlist.companyId || userId !== allowlist.userId)
    throw new ForbiddenException('QA_COMMUNICATION_SCOPE_MISMATCH');
}

export function normalizeQaDestination(channel: QaChannel, value: unknown) {
  if (typeof value !== 'string') return undefined;
  if (channel === 'WHATSAPP') return normalizeQaPhone(value);
  if (channel === 'EMAIL') return normalizeQaEmail(value);
  return normalizeQaSubscription(value);
}

export function qaBusinessKeyPrefix(companyId: string) {
  return `${QA_COMMUNICATION_EVENT}:${companyId}:`;
}

export function maskQaRecipient(channel: QaChannel, recipient: string) {
  if (channel === 'PUSH') return 'QA device';
  if (channel === 'EMAIL') {
    const [local, domain] = recipient.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `***${recipient.slice(-4)}`;
}

function normalizeQaPhone(value?: string) {
  if (!value) return undefined;
  const normalized = value.trim().replace(/[ ()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : undefined;
}

function normalizeQaEmail(value?: string) {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : undefined;
}

function normalizeQaSubscription(value?: string) {
  if (!value) return undefined;
  const normalized = value.trim();
  return uuidPattern.test(normalized) ? normalized : undefined;
}
