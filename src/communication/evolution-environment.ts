import { EvolutionFailure } from './evolution-client.js';
import { uuid } from '../common/validation.js';

export type EvolutionEnvironment = 'DEV' | 'PRODUCTION';
const origins = {
  DEV: 'https://api-dev.kalend.tech',
  PRODUCTION: 'https://api.kalend.tech',
} as const;

/** NODE_ENV=production also applies to DEV builds, so it cannot identify this deployment. */
export function evolutionConfiguration() {
  const value = process.env.EVOLUTION_WEBHOOK_BASE_URL;
  if (!value?.trim())
    throw new EvolutionFailure('EVOLUTION_WEBHOOK_BASE_URL_REQUIRED');
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw new EvolutionFailure('EVOLUTION_WEBHOOK_BASE_URL_INVALID');
  }
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    !Object.values(origins).some((origin) => base.origin === origin)
  ) {
    throw new EvolutionFailure('EVOLUTION_WEBHOOK_BASE_URL_INVALID');
  }
  const environment: EvolutionEnvironment =
    base.origin === origins.DEV ? 'DEV' : 'PRODUCTION';
  // Reuse the existing deployment signal, without inheriting a billing URL as a webhook fallback.
  const billing = process.env.BILLING_PUBLIC_API_URL;
  if (billing) {
    try {
      if (new URL(billing).origin !== base.origin) throw new Error();
    } catch {
      throw new EvolutionFailure('EVOLUTION_ENVIRONMENT_MISMATCH');
    }
  }
  const database = process.env.DATABASE_URL;
  if (database) {
    try {
      const url = new URL(database);
      if (!['postgres:', 'postgresql:'].includes(url.protocol))
        throw new Error();
      const name = decodeURIComponent(url.pathname.slice(1));
      if (environment === 'DEV' ? name !== 'kalend_dev' : name === 'kalend_dev')
        throw new Error();
    } catch {
      throw new EvolutionFailure('EVOLUTION_ENVIRONMENT_MISMATCH');
    }
  }
  return { environment, webhookOrigin: base.origin };
}

/** Default is the legacy local PENDING identity; remote operations always pass their verified environment. */
export function evolutionInstanceName(
  companyId: string,
  environment: EvolutionEnvironment = 'PRODUCTION',
) {
  return `kalend_${environment === 'DEV' ? 'dev_' : ''}${uuid(companyId).toLowerCase().replaceAll('-', '')}`;
}
export function evolutionGlobalName(environment: EvolutionEnvironment) {
  return environment === 'DEV' ? 'kalend_dev_global' : 'kalend_global';
}
export function safeProductionGlobalName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{1,100}$/.test(value) &&
    !/^kalend_dev_/i.test(value) &&
    !/^kalend_[a-f0-9]{32}$/i.test(value)
  );
}
