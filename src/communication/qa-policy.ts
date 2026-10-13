import { ForbiddenException } from '@nestjs/common';
import { normalizeBrazilianPhone } from './recipient.js';

export const QA_COMMUNICATION_EVENT = 'QA_COMMUNICATION_TEST' as const;
export type QaChannel = 'EMAIL' | 'WHATSAPP' | 'PUSH';
export type QaEnvironment = 'DEV' | 'STAGING';

export type QaCommunicationAllowlist = {
  environment: QaEnvironment;
  companyIds: string[];
  emails: string[];
  phones: string[];
  pushSubscriptionIds: string[];
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

function values(...items: (string | undefined)[]) {
  return [...new Set(items.flatMap((item) => item?.split(',') ?? []).map((s) => s.trim()).filter(Boolean))];
}

function normalizeEmail(value?: string) {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized
    : undefined;
}

function normalizeSubscription(value?: string) {
  const normalized = value?.trim();
  return normalized && uuidPattern.test(normalized) ? normalized : undefined;
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

  const companyIds = values(
    env.QA_COMMUNICATION_COMPANY_IDS,
    env.QA_COMMUNICATION_COMPANY_ID,
  );
  if (!companyIds.length || companyIds.some((id) => !uuidPattern.test(id)))
    throw new ForbiddenException('QA_COMMUNICATION_SCOPE_NOT_CONFIGURED');

  const rawEmails = values(
    env.QA_COMMUNICATION_EMAIL_ALLOWLIST,
    env.QA_COMMUNICATION_ALLOWED_EMAIL,
  );
  const rawPhones = values(
    env.QA_COMMUNICATION_PHONE_ALLOWLIST,
    env.QA_COMMUNICATION_ALLOWED_WHATSAPP,
  );
  const rawPushIds = values(
    env.QA_COMMUNICATION_PUSH_SUBSCRIPTION_IDS,
    env.QA_COMMUNICATION_ALLOWED_PUSH_SUBSCRIPTION_ID,
  );
  const emails = rawEmails.map(normalizeEmail);
  const phones = rawPhones.map(normalizeBrazilianPhone);
  const pushSubscriptionIds = rawPushIds.map(normalizeSubscription);
  if (
    emails.some((email) => !email) ||
    phones.some((phone) => !phone) ||
    pushSubscriptionIds.some((id) => !id)
  )
    throw new ForbiddenException('QA_COMMUNICATION_ALLOWLIST_INVALID');

  return {
    environment,
    companyIds: [...new Set(companyIds)],
    emails: emails as string[],
    phones: phones as string[],
    pushSubscriptionIds: pushSubscriptionIds as string[],
  };
}

export function allowedRecipient(
  channel: QaChannel,
  recipient: string,
  targetKey: string,
  allowlist: QaCommunicationAllowlist,
) {
  if (channel === 'EMAIL') return allowlist.emails.includes(recipient.trim().toLowerCase());
  if (channel === 'WHATSAPP')
    return allowlist.phones.includes(normalizeBrazilianPhone(recipient) ?? '');
  return (
    targetKey === recipient &&
    (!allowlist.pushSubscriptionIds.length ||
      allowlist.pushSubscriptionIds.includes(targetKey))
  );
}

export function allowlistedRecipient(
  channel: QaChannel,
  allowlist: QaCommunicationAllowlist,
) {
  if (channel === 'WHATSAPP') return allowlist.phones[0] ?? null;
  if (channel === 'EMAIL') return allowlist.emails[0] ?? null;
  return allowlist.pushSubscriptionIds[0] ?? null;
}

export function isQaCompany(
  companyId: string | null | undefined,
  allowlist: QaCommunicationAllowlist,
) {
  return !!companyId && allowlist.companyIds.includes(companyId);
}

export function assertQaScope(
  companyId: string,
  _userId: string,
  allowlist: QaCommunicationAllowlist,
) {
  if (!isQaCompany(companyId, allowlist))
    throw new ForbiddenException('QA_COMMUNICATION_SCOPE_MISMATCH');
}

export function normalizeQaDestination(channel: QaChannel, value: unknown) {
  if (typeof value !== 'string') return undefined;
  if (channel === 'WHATSAPP') return normalizeBrazilianPhone(value);
  if (channel === 'EMAIL') return normalizeEmail(value);
  return normalizeSubscription(value);
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
