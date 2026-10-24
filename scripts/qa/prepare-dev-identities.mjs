/** Offline preparation only: no database, HTTP, promotion or account mutation. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareIdentityPlan(nonce = randomBytes(8).toString('hex')) {
  if (!/^[0-9a-f]{16}$/.test(nonce)) throw new Error('INVALID_QA_RUN');
  const runId = `QA-E2E-SA-${nonce}`;
  const companies = ['A', 'B'].map(label => ({ id: randomUUID(), name: `${runId}-${label}`, slug: `qa-e2e-sa-${nonce}-${label.toLowerCase()}`, label }));
  const accounts = ['SUPER_ADMIN', 'OWNER_A', 'OWNER_B', 'PROFESSIONAL_A', 'DISABLED_A'].map(role => ({
    id: randomUUID(), role, name: `${runId}-${role}`,
    email: `qa+${role.toLowerCase()}-${nonce}@qa.kalend.invalid`,
    password: randomBytes(24).toString('base64url'),
    isSuperAdmin: role === 'SUPER_ADMIN', isActive: role !== 'DISABLED_A',
    companyId: role === 'SUPER_ADMIN' ? null : companies[role === 'OWNER_B' ? 1 : 0].id,
  }));
  return { version: 1, runId, database: 'kalend_dev', api: 'https://api-dev.kalend.tech', web: 'https://dev.kalend.tech',
    provisioned: false, status: 'PREPARED_NOT_PROVISIONED', companies, accounts,
    constraints: { createOnly: true, updateExisting: false, inferredAdminGrants: false, paidEntitlements: false, messages: false, charges: false },
    pending: ['Explicit QA provisioning authorization', 'Create only the generated new records in one DEV transaction; hash passwords with current bcrypt policy', 'Review legitimate trial fixtures separately; do not infer paid access', 'Verify persisted QA identities before marking provisioned'],
  };
}

export function assertProvisionedQA(plan) {
  if (plan.database !== 'kalend_dev' || plan.api !== 'https://api-dev.kalend.tech' || plan.web !== 'https://dev.kalend.tech' || plan.provisioned !== true)
    throw new Error('QA_CREDENTIALS_NOT_PROVISIONED');
  if (!Array.isArray(plan.accounts) || !plan.accounts.length || plan.accounts.some(a => !/^qa\+[^@]+@qa\.kalend\.invalid$/.test(a.email)))
    throw new Error('QA_IDENTITIES_REQUIRED');
}

export function writePrivatePreparation(parent = homedir()) {
  const directory = mkdtempSync(join(parent, 'kalend-qa-identities-'));
  chmodSync(directory, 0o700);
  const plan = prepareIdentityPlan();
  writeFileSync(join(directory, 'identities.pending.private.json'), JSON.stringify(plan, null, 2)+'\n', { mode: 0o600, flag: 'wx' });
  return { directory, provisioned: false, accounts: plan.accounts.length, companies: plan.companies.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--prepare') {
    console.error('Usage: node scripts/qa/prepare-dev-identities.mjs --prepare (local preparation only)');
    process.exitCode = 1;
  } else console.log(JSON.stringify(writePrivatePreparation()));
}
