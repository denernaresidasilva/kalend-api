-- SELECT only. Execute under a restricted SELECT-only identity in REPEATABLE READ READ ONLY.
-- No PII, provider payload, environment value or secret is returned.
WITH RECURSIVE
observed AS (SELECT CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS at),
proven AS (
 SELECT p.*, s."graceEndsAt" AS sub_grace, s."currentPeriodEnd" AS frontier
 FROM "Payment" p JOIN "Subscription" s ON s.id=p."subscriptionId"
   AND p."companyId"=s."companyId" AND p."planId"=s."planId"
   AND p."billingInterval"=s."billingInterval" AND p.currency=s.currency
 WHERE p.status='APPROVED' AND p."paidAt" IS NOT NULL
   AND p."amountCents">p."refundedAmountCents"
   AND p."periodEnd">p."periodStart" AND p."periodEnd"<=s."currentPeriodEnd"
),
paid_rights AS (
 SELECT DISTINCT "subscriptionId" AS sub_id, "periodStart" AS starts_at, "periodEnd" AS ends_at,
   CASE WHEN "periodEnd"=frontier AND sub_grace>"periodEnd"
       AND sub_grace<="periodEnd"+interval '999 days' THEN sub_grace END AS grace_at,
   'PAYMENT' AS origin
 FROM proven
),
manual_rights AS (
 SELECT s.id AS sub_id, s."currentPeriodStart" AS starts_at, s."currentPeriodEnd" AS ends_at,
   NULL::timestamp AS grace_at, 'ADMIN_GRANT' AS origin
 FROM "Subscription" s WHERE s.gateway='MANUAL' AND s."currentPeriodEnd">s."currentPeriodStart"
   AND NOT EXISTS (SELECT 1 FROM paid_rights r WHERE r.sub_id=s.id
     AND r.starts_at=s."currentPeriodStart" AND r.ends_at=s."currentPeriodEnd")
),
rights AS (SELECT * FROM paid_rights UNION ALL SELECT * FROM manual_rights),
coverage(sub_id,frontier) AS (
 SELECT s.id,r.ends_at FROM "Subscription" s JOIN rights r ON r.sub_id=s.id
 WHERE r.starts_at<=s."currentPeriodStart" AND r.ends_at>s."currentPeriodStart"
 UNION
 SELECT c.sub_id,r.ends_at FROM coverage c JOIN rights r ON r.sub_id=c.sub_id
 JOIN "Subscription" s ON s.id=c.sub_id
 WHERE r.starts_at<=c.frontier AND r.ends_at>c.frontier AND c.frontier<s."currentPeriodEnd"
),
subscriptions AS (
 SELECT s.id,s."companyId" AS company_id,s.status,s.gateway,
   EXISTS (SELECT 1 FROM coverage c WHERE c.sub_id=s.id AND c.frontier>=s."currentPeriodEnd")
     AND s."currentPeriodStart" IS NOT NULL AND s."currentPeriodEnd">s."currentPeriodStart" AS covered,
   (s.status='ACTIVE' AND (s."currentPeriodEnd" IS NULL OR s."currentPeriodEnd">o.at))
     OR (s.status='PAST_DUE' AND (s."currentPeriodEnd">o.at OR s."graceEndsAt">o.at)) AS live_claim,
   s."currentPeriodStart" IS NULL OR s."currentPeriodEnd" IS NULL
     OR s."currentPeriodEnd"<=s."currentPeriodStart" AS invalid_period,
   s.status='PAST_DUE' AND s."graceEndsAt">s."currentPeriodEnd"
     AND NOT EXISTS (SELECT 1 FROM paid_rights r WHERE r.sub_id=s.id
       AND r.ends_at=s."currentPeriodEnd" AND r.grace_at>=s."graceEndsAt") AS unproven_grace,
   EXISTS (SELECT 1 FROM manual_rights r WHERE r.sub_id=s.id) AS legacy_grant
 FROM "Subscription" s CROSS JOIN observed o
),
classified_subscriptions AS (
 SELECT *, CASE
   WHEN status IN ('ACTIVE','PAST_DUE') AND live_claim
     AND (invalid_period OR NOT covered OR unproven_grace) THEN 'BLOCK_MIGRATION_REVIEW'
   WHEN legacy_grant THEN 'IMPORT_LEGACY_ADMIN_GRANT'
   WHEN EXISTS (SELECT 1 FROM paid_rights r WHERE r.sub_id=subscriptions.id) THEN 'IMPORT_PAID_RIGHTS'
   ELSE 'NO_PROVEN_RIGHT_IMPORTED' END AS classification
 FROM subscriptions
),
classified_payments AS (
 SELECT p.id,p."companyId" AS company_id,p."subscriptionId" AS subscription_id,
   CASE
     WHEN s.id IS NULL THEN 'NO_SUBSCRIPTION_NO_IMPORT'
     WHEN p."companyId"<>s."companyId" OR p."planId" IS DISTINCT FROM s."planId"
       OR p."billingInterval"<>s."billingInterval" OR p.currency<>s.currency THEN 'REVIEW_SCOPE_MISMATCH'
     WHEN p.status='REFUNDED' OR p."amountCents"<=p."refundedAmountCents" THEN 'REVERSED_NO_PROOF'
     WHEN p.status<>'APPROVED' THEN 'NOT_APPROVED_NO_PROOF'
     WHEN p."paidAt" IS NULL THEN 'REVIEW_APPROVAL_WITHOUT_PAID_AT'
     WHEN p."periodStart" IS NULL OR p."periodEnd" IS NULL OR p."periodEnd"<=p."periodStart" THEN 'REVIEW_INVALID_PERIOD'
     WHEN s."currentPeriodEnd" IS NULL OR p."periodEnd">s."currentPeriodEnd" THEN 'REVIEW_OUTSIDE_PAID_FRONTIER'
     ELSE 'IMPORT_PAYMENT_EVIDENCE' END AS classification,
   p."refundedAmountCents">0 AS partial_or_full_refund,
   EXISTS (SELECT 1 FROM proven q WHERE q.id<>p.id AND q."subscriptionId"=p."subscriptionId"
     AND q."periodStart"=p."periodStart" AND q."periodEnd"=p."periodEnd") AS duplicate_paid_period
 FROM "Payment" p LEFT JOIN "Subscription" s ON s.id=p."subscriptionId"
)
SELECT jsonb_build_object(
 'database',current_database(),'snapshot_utc',(SELECT at FROM observed),
 'migration_guard_would_abort',EXISTS(SELECT 1 FROM classified_subscriptions WHERE classification='BLOCK_MIGRATION_REVIEW'),
 'subscription_count',(SELECT count(*) FROM classified_subscriptions),
 'payment_count',(SELECT count(*) FROM classified_payments),
 'inferred_right_count',(SELECT count(*) FROM rights),
 'subscriptions',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM classified_subscriptions s),'[]'::jsonb),
 'payments',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM classified_payments p),'[]'::jsonb)
) AS report;
