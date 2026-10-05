import {
  safeProductionGlobalName,
  type EvolutionEnvironment,
} from './evolution-environment.js';

export type EvolutionPreflightRow = {
  id: string;
  companyId: string | null;
  globalKey?: string | null;
  instanceName: string;
  environment?: EvolutionEnvironment | null;
  companyExists?: boolean;
};
function migrationCompanyName(
  companyId: string,
  environment: EvolutionEnvironment = 'PRODUCTION',
) {
  // PostgreSQL UUID accepts any version/variant; match its canonical text without a stricter API UUID policy.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      companyId,
    )
  )
    throw new Error();
  return (
    'kalend_' +
    (environment === 'DEV' ? 'dev_' : '') +
    companyId.toLowerCase().replaceAll('-', '')
  );
}
/** Mirrors the immutable second migration's CHECK, including SQL NULL rejection. */
export function compatibleWithGlobalMigration(row: EvolutionPreflightRow) {
  if (row.companyId)
    return (
      row.globalKey == null &&
      row.instanceName === migrationCompanyName(row.companyId)
    );
  return (
    row.globalKey === 'GLOBAL' &&
    /^[A-Za-z0-9_-]{1,100}$/.test(row.instanceName) &&
    !/^kalend_[a-f0-9]{32}$/i.test(row.instanceName)
  );
}
export function compatibleWithEnvironmentMigration(row: EvolutionPreflightRow) {
  if (row.environment == null) return compatibleWithGlobalMigration(row);
  if (!['DEV', 'PRODUCTION'].includes(row.environment)) return false;
  if (row.companyId)
    return (
      row.globalKey == null &&
      row.instanceName === migrationCompanyName(row.companyId, row.environment)
    );
  return (
    row.globalKey === 'GLOBAL' &&
    (row.environment === 'DEV'
      ? row.instanceName === 'kalend_dev_global'
      : safeProductionGlobalName(row.instanceName))
  );
}
export function evolutionPreflight(
  rows: EvolutionPreflightRow[],
  environment: EvolutionEnvironment,
  globalMigrationApplied = false,
) {
  const issues: Array<{ id: string; codes: string[] }> = [];
  const companyIds = new Set<string>();
  const names = new Set<string>();
  let globals = 0;
  let legacyDevRebinding = 0;
  for (const row of rows) {
    const codes: string[] = [];
    try {
      if (!globalMigrationApplied && !compatibleWithGlobalMigration(row))
        codes.push('GLOBAL_MIGRATION_CHECK_FAILED');
      if (!compatibleWithEnvironmentMigration(row))
        codes.push('ENVIRONMENT_MIGRATION_CHECK_FAILED');
    } catch {
      codes.push('INVALID_COMPANY_ID');
    }
    if (row.environment && row.environment !== environment)
      codes.push('CONNECTION_ENVIRONMENT_MISMATCH');
    if (row.companyId && row.companyExists === false)
      codes.push('COMPANY_FOREIGN_KEY_FAILED');
    if (row.companyId && companyIds.has(row.companyId))
      codes.push('DUPLICATE_COMPANY');
    if (row.companyId) companyIds.add(row.companyId);
    if (names.has(row.instanceName)) codes.push('DUPLICATE_INSTANCE_NAME');
    names.add(row.instanceName);
    if (row.globalKey === 'GLOBAL' && ++globals > 1)
      codes.push('DUPLICATE_GLOBAL');
    if (environment === 'DEV' && row.environment == null) legacyDevRebinding++;
    if (codes.length)
      issues.push({
        id: /^[0-9a-f-]{36}$/i.test(row.id) ? row.id : 'row_' + issues.length,
        codes,
      });
  }
  // Only IDs, counts and fixed codes; never echo arbitrary snapshot fields or secrets.
  return {
    compatible: issues.length === 0,
    rowCount: rows.length,
    legacyDevRebinding,
    issues,
  };
}
