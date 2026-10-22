# Arquivos incorporados à release local

Inclui trabalho anterior preservado e correções desta execução. Sem commit de .env, logs brutos, perfis, node_modules ou dados de banco.

## kalend-api

- `ENTITLEMENT-GRACE-SECURITY.md`
- `package-lock.json`
- `package.json`
- `prisma/migrations/20261017090000_subscription_entitlement_evidence/migration.sql`
- `prisma/schema.prisma`
- `scripts/test-native-postgres.mjs`
- `scripts/validate-trial-access.mjs`
- `src/billing/adapters/asaas.adapter.ts`
- `src/billing/admin-grant.ts`
- `src/billing/billing-domain.ts`
- `src/billing/billing.spec.ts`
- `src/billing/commercial-policy.spec.ts`
- `src/billing/commercial-policy.ts`
- `src/billing/lifecycle.service.spec.ts`
- `src/billing/payments.service.spec.ts`
- `src/billing/payments.service.ts`
- `src/billing/qa-simulation-cli.spec.ts`
- `src/billing/qa-simulation.service.ts`
- `src/billing/renewals.spec.ts`
- `src/billing/transaction-conflict.spec.ts`
- `src/billing/transaction-conflict.ts`
- `src/billing/webhook-processor.service.ts`
- `src/communication/engine.ts`
- `src/companies/companies.controller.ts`
- `src/companies/companies.service.spec.ts`
- `src/companies/companies.service.ts`
- `src/notifications/notifications.service.ts`
- `src/notifications/notifications.spec.ts`
- `test/commercial-qa-simulation.e2e-spec.ts`
- `test/entitlement-backfill.e2e-spec.ts`
- `test/entitlement-evidence.e2e-spec.ts`
- `test/entitlement-native.native.ts`
- `test/subscription-grace-timing.e2e-spec.ts`
- `test/support/native-postgres.ts`
- `test/support/paid-entitlement.ts`
- `test/suspended-recovery.e2e-spec.ts`
- `vitest.config.native.ts`

## kalend-web

- `homologacao/specs/checkout.local.spec.ts`
- `homologacao/specs/core.local.spec.ts`
- `package-lock.json`
- `package.json`

## Documentação API adicional

- `docs/homologacao/SUPER_ADMIN_STATUS.md` e histórico de 21/10.
- `docs/homologacao/SUPER_ADMIN_MATRIZ.md`, JSON e histórico de 21/10.
- `docs/homologacao/RELEASE_DEV_CONTROLADA.md`.
- `docs/homologacao/ARQUIVOS_RELEASE.md`.
- Resumos, hashes e relatórios JSON selecionados em `docs/homologacao/evidencias/`.


## Preparação controlada subsequente (sem deploy)

- `docs/homologacao/release-controlada/readonly-role.sql`
- `docs/homologacao/release-controlada/backfill-audit.sql`
- `docs/homologacao/release-controlada/sudoers-dev-only.conf`
- `docs/homologacao/release-controlada/kalend-dev-audit`
- `docs/homologacao/release-controlada/authorized_keys.example`
- `docs/homologacao/release-controlada/kalend-dev-release-gate`
- `docs/homologacao/release-controlada/INTERVENCAO_ADMINISTRATIVA.md`
- `docs/homologacao/release-controlada/preflight.workflow.example.yml`
- `docs/homologacao/release-controlada/pg_hba.fragment.conf`
- `test/entitlement-backfill.e2e-spec.ts`
- `test/release-access.native.ts`
- `scripts/tests/test_release_access_templates.py`
- `vitest.config.native.ts`

Atualizados também status, matriz, plano de release, regras de exclusão de artefatos e relatórios estruturados de preparação. Código de produto, dependências, migration e Web não foram alterados nesta execução.
