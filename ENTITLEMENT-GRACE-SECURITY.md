# Entitlement and grace evidence

Local implementation for review. No remote migration or deployment was performed.

## Rights and authorization

`SubscriptionEntitlement` records one effective interval belonging to a Subscription (and therefore its Company). `PaymentEvidence` records each individual Payment, its immutable tenant/contract/period binding, current financial validity, review state, and the effective interval it supports. Several valid payments can support one exact interval; partially overlapping contracted intervals remain separate evidence and authorization sees their temporal union. `ADMIN_GRANT` records the authenticated Super Admin, grant time and period. No administrative grant creates a Payment or revenue.

`entitledWhere` remains the common Prisma predicate used by auth membership, product entitlements, regularization, company suspension and recovery selection. It requires administrative ACTIVE. Trial eligibility is preserved. ACTIVE/PAST_DUE require a non-revoked right within its period. Grace requires PAST_DUE, a future subscription deadline, and an authorized right whose own bounded grace deadline has not expired. SUSPENDED/CANCELED never grant product access.

A payment-backed right remains usable only while its Payment is APPROVED with paidAt. Full refund changes the Payment to REFUNDED and immediately removes that evidence from authorization. Partial refund retains APPROVED with remaining value under the existing domain rule. The existing payment schema has no separate chargeback status: providers must map reversals to the existing verified financial transitions; this change adds no new financial status.

A database validation trigger enforces Payment/Subscription/Company/plan/interval/currency/period consistency and remaining paid value when evidence is created. Evidence identity and period cannot be edited. Financial state remains live, so reversal invalidates only that Payment's evidence without fabricating another Payment. Exact or partial overlap with another valid Payment is retained as evidence, flagged for financial review, and does not multiply access time. Periods must match the contracted monthly/yearly duration; incompatible periods remain in REVIEW without granting access. Existing valid rights on another subscription remain available; their payments cannot be attached to a different subscription.

## Grace

A first unpaid attempt may become PAST_DUE, but has no right to extend: no grace deadline or grace event is created. Changing only graceEndsAt cannot authorize it.

For a paid period, grace is anchored to its immutable end, using the existing process/QA day policy (0–999). Zero means no new grace window. A positive day is 86,400,000 milliseconds. A persisted positive right deadline cannot be extended by retries. Administrative grants receive no implicit grace: adminGraceDays must explicitly authorize a bounded extension at creation. Historical grants never receive grace.

`beginGrace` no longer rewrites currentPeriodEnd or manufactures an expired paid period. It requires an actually elapsed proven period. Consequently a QA call cannot advance a future paid period into grace. A later lifecycle test must arrange a legitimately short-lived paid test period in an ephemeral environment or use a separately reviewed QA time mechanism; the DEV fixture was not changed here.

The new migration preserves clock_timestamp() at UTC, the existing temporal predicate, durable keys and QA/commercial selection. Both synchronous capture and temporal generation additionally verify grace evidence. A late FAILED/OVERDUE notification does not reopen an already suspended Subscription. Approval remains the recovery path.

## Administrative API

`POST /companies/manual` remains protected by AdminGuard. The server passes req.auth.user.id, never a body-supplied actor. The service checks that actor against the database, including inside grant creation. Existing request fields remain valid. With startWithTrial=false, a grant is created atomically with Company and Subscription. Optional `adminGraceDays` is an integer 0–999, default 0; positive tolerance is rejected for trial creation. Existing UI uses the safe default. Visual validation of an optional grace input is deferred; no web changes were made.

`POST /companies/:id/entitlements/:entitlementId/revoke` is Super Admin only. It scopes the administrative grant to the requested Company, records the first revoker/time, preserves the row and is idempotent. Payment evidence cannot be revoked using this administrative route. Company administrativeStatus is never enabled by revocation or by a payment for DISABLED/LEGACY_UNKNOWN.

## Migration and legacy classification

`20261017090000_subscription_entitlement_evidence` is additive and transactional. Historical migrations are unchanged. No Subscription, Company, Payment, Outbox or Delivery row is rewritten.

- APPROVED Payment evidence with paidAt, positive remaining value and matching tenant/subscription/plan/interval/currency is imported as PAYMENT for periods up to the persisted paid frontier. This preserves a still-current prior period when the next period was prepaid; an unapplied future frontier is not imported. Only an already persisted bounded grace is retained.
- Existing MANUAL periods with valid start/end are preserved as legacy ADMIN_GRANT snapshots when the exact current administrative period has no imported paid evidence. Actor and grant time remain null. Dates are copied unchanged. No consent or grace permission is inferred from MANUAL.
- A live ACTIVE/PAST_DUE period without a safe classification aborts migration with ENTITLEMENT_BACKFILL_REQUIRES_REVIEW instead of silently revoking a potentially legitimate customer. The guard verifies continuous coverage of the persisted half-open interval `[currentPeriodStart, currentPeriodEnd)`, including adjacent or overlapping evidence, and rejects gaps or evidence belonging only to an older period. ACTIVE with a NULL boundary is ambiguous and aborts; PAST_DUE with NULL boundaries aborts if it claims a live grace window. PAST_DUE without a current-period or grace claim, PENDING, and SUSPENDED do not gain evidence by inference.
- Two distinct valid approved Payments for the same imported Subscription period are preserved as alternative `PaymentEvidence` rows pointing to one canonical entitlement and flagged for financial review. The interval is granted once; the migration does not create duplicate access periods or discard either Payment.
- Grace is validated separately from period coverage. A future positive PAST_DUE grace claim must be backed by a non-revoked entitlement ending at `currentPeriodEnd` whose own persisted grace reaches the claimed deadline. Historical ADMIN_GRANT does not satisfy this check because the backfill never invents administrative grace permission.

The migration uses a unique canonical key `(subscriptionId, startsAt, endsAt)` for PAYMENT entitlements and a unique `paymentId` for each evidence row. This allows alternative financial evidence without duplicating a right. In the write path, a row lock serializes entitlement mutation per Subscription; overlapping contracted intervals are stored separately and flagged for financial review, and coverage is evaluated as a union rather than by adding durations.
- Invalid grace without evidence does not become a right.

The snapshot is a legacy classification, not a claim that a historical administrator was identified. Before any future remote deployment, review the migration guard on an authorized dataset and classify any ambiguous records through a separate decision. Do not bypass the guard or synthesize payments.

## Operational boundaries

Only local/ephemeral databases were used. No remote connection, env edit, timer change, message delivery, financial provider call, commit, push or deploy is part of this implementation. QA_SIMULATION APPROVED can produce payment evidence through the shared domain but remains excluded from Finance/Dashboard revenue aggregation. Existing DEV-only and recipient policies are unchanged.

## Local validation

- Unit/integration: 862 passed (53 files).
- E2E: 243 passed (14 files), including persisted evidence, backfill, recovery, and communication regressions.
- `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npx prisma validate`, `npx prisma generate` and `git diff --check`: passed. Prisma tooling used an inert local datasource; migrations were executed only in PGlite.
- Backfill regression cases run against PGlite and cover exact, partial, adjacent, overlapping, gapped, historical, cross-subscription/company, NULL-boundary, grace, refund, and rollback behavior. PGlite validates SQL behavior and logical idempotency, but does not establish native PostgreSQL lock contention behavior. Native multi-connection concurrency and an authorized read-only backfill review remain deployment prerequisites; no remote deployment or DEV database access was performed in this audit.

## Changed files

- prisma/schema.prisma
- prisma/migrations/20261017090000_subscription_entitlement_evidence/migration.sql
- src/billing/admin-grant.ts
- src/billing/billing-domain.ts
- src/billing/commercial-policy.ts
- src/billing/payments.service.ts
- src/billing/qa-simulation.service.ts
- src/communication/engine.ts
- src/companies/companies.controller.ts
- src/companies/companies.service.ts
- src/billing/billing.spec.ts
- src/billing/commercial-policy.spec.ts
- src/billing/lifecycle.service.spec.ts
- src/billing/payments.service.spec.ts
- src/billing/qa-simulation-cli.spec.ts
- src/billing/renewals.spec.ts
- src/companies/companies.service.spec.ts
- test/commercial-qa-simulation.e2e-spec.ts
- test/entitlement-backfill.e2e-spec.ts
- test/entitlement-evidence.e2e-spec.ts
- test/subscription-grace-timing.e2e-spec.ts
- test/suspended-recovery.e2e-spec.ts
- test/support/paid-entitlement.ts
- ENTITLEMENT-GRACE-SECURITY.md
