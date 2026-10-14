import type { GatewayEnvironment } from '@prisma/client';
import { email } from './contracts.js';
import { qaRuntimeEnvironment } from './qa-policy.js';

export const DEV_SMTP_SANDBOX = {
  host: '127.0.0.1',
  port: '1025',
  secure: 'false',
  username: '',
  fromName: 'Kalend DEV',
  fromEmail: 'no-reply@kalend.dev',
} as const;

function configuredEmails(env: NodeJS.ProcessEnv) {
  const values = [
    env.QA_COMMUNICATION_EMAIL_ALLOWLIST,
    env.QA_COMMUNICATION_ALLOWED_EMAIL,
  ]
    .flatMap((value) => value?.split(',') ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length) return null;
  try {
    return [...new Set(values.map((value) => email(value)))];
  } catch {
    return null;
  }
}

/** DEV mail is permitted only through an explicitly enabled loopback sink. */
export function devSmtpSandboxReady(env: NodeJS.ProcessEnv = process.env) {
  return (
    qaRuntimeEnvironment(env) === 'DEV' &&
    env.COMMUNICATION_DEV_SMTP_SANDBOX_ENABLED === 'true' &&
    configuredEmails(env) !== null
  );
}

export function isDevEmailAllowed(
  recipient: unknown,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (qaRuntimeEnvironment(env) !== 'DEV') return true;
  if (!devSmtpSandboxReady(env) || typeof recipient !== 'string') return false;
  try {
    return configuredEmails(env)?.includes(email(recipient)) === true;
  } catch {
    return false;
  }
}

/** GatewayEnvironment has no DEV value; SANDBOX is the persisted non-production label. */
export function deliveryEnvironment(
  provider: string,
  providerEnvironment: GatewayEnvironment,
  env: NodeJS.ProcessEnv = process.env,
): GatewayEnvironment {
  if (
    qaRuntimeEnvironment(env) === 'DEV' &&
    (provider === 'SMTP' || provider === 'EVOLUTION')
  )
    return 'SANDBOX';
  return providerEnvironment;
}

export function isLegacyDevDeliveryEnvironment(
  provider: string,
  environment: GatewayEnvironment,
  env: NodeJS.ProcessEnv = process.env,
) {
  return (
    qaRuntimeEnvironment(env) === 'DEV' &&
    (provider === 'SMTP' || provider === 'EVOLUTION') &&
    environment === 'PRODUCTION'
  );
}
