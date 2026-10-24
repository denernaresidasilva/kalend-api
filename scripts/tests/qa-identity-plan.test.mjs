import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareIdentityPlan, writePrivatePreparation, assertProvisionedQA } from '../qa/prepare-dev-identities.mjs';

test('new QA-only identities never attach to existing tenants or infer paid rights', () => {
  const p = prepareIdentityPlan('0123456789abcdef');
  assert.equal(p.provisioned, false); assert.equal(p.accounts.length, 5);
  assert.equal(p.accounts.filter(a => a.isSuperAdmin).length, 1);
  assert.equal(p.accounts.filter(a => !a.isActive).length, 1);
  assert.equal(new Set(p.accounts.map(a => a.id)).size, 5);
  for (const a of p.accounts) {
    assert.match(a.email, /^qa\+[^@]+@qa\.kalend\.invalid$/); assert.ok(a.password.length >= 24 && Buffer.byteLength(a.password) <= 72);
    if (a.companyId) assert.ok(p.companies.some(c => c.id === a.companyId));
  }
  assert.equal(p.constraints.updateExisting, false); assert.equal(p.constraints.messages, false);
  assert.equal(p.constraints.charges, false); assert.equal(p.constraints.paidEntitlements, false);
});
test('pending, production and non-QA credentials are rejected before authentication', () => {
  const p = prepareIdentityPlan(); assert.throws(() => assertProvisionedQA(p));
  assert.throws(() => assertProvisionedQA({ ...p, provisioned: true, database: 'kalend' }));
  assert.throws(() => assertProvisionedQA({ ...p, provisioned: true, accounts: [{ email: 'real@example.com' }] }));
  assert.doesNotThrow(() => assertProvisionedQA({ ...p, provisioned: true }));
  assert.throws(() => prepareIdentityPlan('../unsafe'));
});
test('private preparation uses 0700/0600, unique destinations and never reports credentials', () => {
  const parent = mkdtempSync(join(tmpdir(), 'kalend-qa-plan-test-'));
  try {
    const a = writePrivatePreparation(parent), b = writePrivatePreparation(parent);
    assert.notEqual(a.directory, b.directory); assert.equal(statSync(a.directory).mode & 0o777, 0o700);
    const file = join(a.directory, 'identities.pending.private.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    for (const account of plan.accounts) assert.ok(!JSON.stringify(a).includes(account.password));
    assert.equal(a.provisioned, false);
  } finally { rmSync(parent, { recursive: true }); }
});
