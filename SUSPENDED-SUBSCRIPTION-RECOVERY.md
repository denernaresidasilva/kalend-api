# Suspended subscription recovery

Company.status remains commercial (TRIAL, ACTIVE, SUSPENDED, CANCELED). Company.administrativeStatus is independent: ACTIVE, DISABLED or LEGACY_UNKNOWN. isActive remains a compatibility gate; it is never evidence of administrative authorization by itself.

## Migration and legacy classification

20261016090000_company_administrative_recovery adds the enum and column. Existing rows default to LEGACY_UNKNOWN. Only rows with isActive=true AND commercial status ACTIVE/TRIAL are backfilled ACTIVE. All others, including isActive=false and CANCELED, stay LEGACY_UNKNOWN until explicit Super Admin review. The future default is ACTIVE. No commercial status, isActive flag, updatedAt, Payment, Subscription, event or delivery is backfilled. No indexes are needed.

The same migration replaces the existing capture function to recognize a new persisted graceEndsAt window even when status was already PAST_DUE. It retains clock_timestamp, the real due-window predicate and deterministic deduplication keys. It does not backfill events or modify historical migrations.

## Administrative authority

The existing Super Admin company update action maps explicit status SUSPENDED to administrative DISABLED, while ACTIVE/TRIAL explicitly restore administrative ACTIVE. CANCELED does not imply administrative DISABLED. The same protected update API accepts administrativeStatus ACTIVE/DISABLED for independent review; LEGACY_UNKNOWN is migration-only. Administrative enablement alone never creates an entitlement or pays a subscription. Deleted companies are physically removed and cannot be recovered by billing.

OWNER authentication, tenant selection, regularization, checkout and entitlement lookup require administrative ACTIVE. A user with another valid membership may still authenticate to that other tenant. Commercially suspended companies retain recovery access; disabled/unknown memberships do not authorize billing. Global Super Admin authentication remains independent.

## Real checkout and approved webhook

The backend selects the latest PAST_DUE/SUSPENDED subscription only when there is no valid ACTIVE/TRIALING entitlement. Regularization exposes recoverySubscriptionId; checkout independently resolves it inside its serializable transaction. No browser-supplied subscription ID is accepted by normal checkout. Plan, billing interval, gateway and environment must match; catalog price remains authoritative. Incompatible changes are rejected rather than creating a competing subscription.

Recovery creates a one-off Payment bound to that same subscription. It calls createCharge, never createSubscription, even when an existing external recurring mandate is present; recurring=true is rejected for recovery. Existing adapter charge/customer behavior is unchanged. No new recurring mandate or external subscription is provisioned. Unknown external operations remain UNCERTAIN and require reconciliation, never blind repeat. Normal pending-payment and idempotency guards still apply.

Webhook verification stays provider-specific. A verified APPROVED payment is recorded even if the company became DISABLED/LEGACY_UNKNOWN after checkout. BillingDomain.activatePaid refuses to activate its subscription or company in that case. With administrative ACTIVE, valid payment period and no newer conflicting entitlement, it reactivates the bound subscription, clears grace, sets Company ACTIVE/isActive=true, and the existing database trigger emits SUBSCRIPTION_REACTIVATED once. Replayed webhooks and approved payments cannot duplicate that transition. Browser refresh reads authoritative commercial state; /conta/regularizar remains canonical and /conta/planos may redirect there.

An approval already performs reactivation. Calling the explicit QA SUBSCRIPTION_REACTIVATED command afterwards is unnecessary; that command requires approved paid proof on a still PAST_DUE/SUSPENDED subscription.

## DEV QA operations

QA uses the same domain and recovery selector. Commercially SUSPENDED administrative ACTIVE companies are limited to preflight and recovery actions. Recovery attempts require --subscription and a QA_SIMULATION/SANDBOX subscription belonging to the same company. Other entitlement conflicts and foreign tenants are rejected. DISABLED/LEGACY_UNKNOWN and PROD remain fail-closed.

--grace-days is an isolated domain policy, never a process.env assignment or remote .env change. It is supported only for FAILED/OVERDUE/GRACE. Positive grace during OVERDUE may already emit GRACE: that is the real domain window, not an additional synthetic transition. Global BILLING_GRACE_DAYS remains 0..999, absent=0, unchanged by QA.

The fixture command creates Company + OWNER membership, reusing an existing allowlisted QA owner. No initial entitlement or COMPANY Evolution is created. GLOBAL communications use the existing DEV global provider. New UUID allowlisting is deliberately a separate private authorization step. Neither fixture nor lifecycle is run during deployment.
