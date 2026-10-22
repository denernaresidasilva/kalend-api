BEGIN;
CREATE TYPE "EntitlementOrigin" AS ENUM ('PAYMENT', 'ADMIN_GRANT');
CREATE TYPE "PaymentEvidenceStatus" AS ENUM ('APPLIED', 'REVIEW', 'REVOKED');
CREATE TABLE "SubscriptionEntitlement" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscriptionId" uuid NOT NULL REFERENCES "Subscription"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  origin "EntitlementOrigin" NOT NULL,
  "startsAt" timestamp(3) NOT NULL,
  "endsAt" timestamp(3) NOT NULL,
  "graceEndsAt" timestamp(3),
  "grantedById" uuid REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "grantedAt" timestamp(3),
  legacy boolean NOT NULL DEFAULT false,
  "revokedAt" timestamp(3),
  "revokedById" uuid REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT entitlement_period CHECK ("endsAt" > "startsAt"),
  CONSTRAINT entitlement_grace CHECK ("graceEndsAt" IS NULL OR ("graceEndsAt" > "endsAt" AND "graceEndsAt" <= "endsAt" + interval '999 days')),
  CONSTRAINT entitlement_revocation CHECK ("revokedAt" IS NULL OR "revokedById" IS NOT NULL),
  CONSTRAINT entitlement_evidence CHECK (
    (origin = 'PAYMENT' AND "grantedById" IS NULL AND "grantedAt" IS NULL)
    OR (origin = 'ADMIN_GRANT' AND
      ((legacy AND "grantedById" IS NULL AND "grantedAt" IS NULL AND "graceEndsAt" IS NULL)
       OR (NOT legacy AND "grantedById" IS NOT NULL AND "grantedAt" IS NOT NULL))))
);
CREATE INDEX "SubscriptionEntitlement_subscriptionId_idx" ON "SubscriptionEntitlement"("subscriptionId");
CREATE UNIQUE INDEX "SubscriptionEntitlement_payment_period_key"
  ON "SubscriptionEntitlement"("subscriptionId", "startsAt", "endsAt") WHERE origin='PAYMENT';
CREATE TABLE "PaymentEvidence" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "paymentId" uuid NOT NULL UNIQUE REFERENCES "Payment"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "companyId" uuid NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "subscriptionId" uuid NOT NULL REFERENCES "Subscription"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "entitlementId" uuid REFERENCES "SubscriptionEntitlement"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "startsAt" timestamp(3),
  "endsAt" timestamp(3),
  status "PaymentEvidenceStatus" NOT NULL DEFAULT 'APPLIED',
  "reviewReason" text,
  "financialReviewRequired" boolean NOT NULL DEFAULT false,
  "revokedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payment_evidence_period CHECK (status<>'APPLIED' OR ("startsAt" IS NOT NULL AND "endsAt" > "startsAt")),
  CONSTRAINT payment_evidence_state CHECK
    ((status='APPLIED' AND "entitlementId" IS NOT NULL AND "revokedAt" IS NULL)
      OR (status='REVIEW' AND "entitlementId" IS NULL AND "reviewReason" IS NOT NULL AND "revokedAt" IS NULL)
      OR (status='REVOKED' AND "revokedAt" IS NOT NULL))
);
CREATE INDEX "PaymentEvidence_subscription_status_period_idx"
  ON "PaymentEvidence"("subscriptionId", status, "startsAt", "endsAt");
CREATE INDEX "PaymentEvidence_companyId_idx" ON "PaymentEvidence"("companyId");
CREATE INDEX "PaymentEvidence_entitlementId_idx" ON "PaymentEvidence"("entitlementId");
-- Import proven periods up to the subscription paid frontier, including a still-valid
-- previous period when the next period was prepaid. Never import an unapplied future frontier.
-- Existing positive, persisted grace is bounded by the same proven period (never invented).
INSERT INTO "SubscriptionEntitlement" ("subscriptionId", origin, "startsAt", "endsAt", "graceEndsAt", legacy)
SELECT DISTINCT s.id, 'PAYMENT'::"EntitlementOrigin", p."periodStart", p."periodEnd",
 CASE WHEN p."periodEnd" = s."currentPeriodEnd" AND s."graceEndsAt" > p."periodEnd" AND s."graceEndsAt" <= p."periodEnd" + interval '999 days' THEN s."graceEndsAt" END, true
FROM "Subscription" s JOIN "Payment" p ON p."subscriptionId" = s.id
 AND p."companyId" = s."companyId" AND p."planId" = s."planId"
 AND p."billingInterval" = s."billingInterval" AND p.currency = s.currency
 AND p."periodEnd" <= s."currentPeriodEnd"
WHERE p.status = 'APPROVED' AND p."paidAt" IS NOT NULL
 AND p."amountCents" > p."refundedAmountCents" AND p."periodEnd" > p."periodStart"
ON CONFLICT ("subscriptionId", "startsAt", "endsAt") WHERE origin='PAYMENT' DO NOTHING;
INSERT INTO "PaymentEvidence" ("paymentId", "companyId", "subscriptionId", "entitlementId", "startsAt", "endsAt", "financialReviewRequired", "reviewReason")
SELECT p.id, s."companyId", s.id, e.id, p."periodStart", p."periodEnd",
  EXISTS (SELECT 1 FROM "Payment" p2 WHERE p2.id<>p.id AND p2."subscriptionId"=s.id
    AND p2."periodStart"=p."periodStart" AND p2."periodEnd"=p."periodEnd"
    AND p2.status='APPROVED' AND p2."paidAt" IS NOT NULL AND p2."amountCents">p2."refundedAmountCents"),
  CASE WHEN EXISTS (SELECT 1 FROM "Payment" p2 WHERE p2.id<>p.id AND p2."subscriptionId"=s.id
    AND p2."periodStart"=p."periodStart" AND p2."periodEnd"=p."periodEnd"
    AND p2.status='APPROVED' AND p2."paidAt" IS NOT NULL AND p2."amountCents">p2."refundedAmountCents")
    THEN 'POSSIBLE_DUPLICATE_CHARGE' END
FROM "Subscription" s JOIN "Payment" p ON p."subscriptionId"=s.id
 AND p."companyId"=s."companyId" AND p."planId"=s."planId"
 AND p."billingInterval"=s."billingInterval" AND p.currency=s.currency
 JOIN "SubscriptionEntitlement" e ON e."subscriptionId"=s.id AND e.origin='PAYMENT'
 AND e."startsAt"=p."periodStart" AND e."endsAt"=p."periodEnd"
WHERE p.status='APPROVED' AND p."paidAt" IS NOT NULL
 AND p."amountCents">p."refundedAmountCents" AND p."periodEnd">p."periodStart";
-- Historical MANUAL periods are preserved as legacy administrative grants, not payments.
-- No actor, consent, new validity dates, or grace permission is fabricated.
INSERT INTO "SubscriptionEntitlement" ("subscriptionId", origin, "startsAt", "endsAt", legacy)
SELECT s.id, 'ADMIN_GRANT'::"EntitlementOrigin", s."currentPeriodStart", s."currentPeriodEnd", true
FROM "Subscription" s WHERE s.gateway = 'MANUAL'
 AND s."currentPeriodEnd" > s."currentPeriodStart"
 -- A payment-backed period is not independent evidence of an administrative grant.
 -- Otherwise refunding its only payment would leave an inferred access bypass.
 AND NOT EXISTS (SELECT 1 FROM "SubscriptionEntitlement" e WHERE e."subscriptionId" = s.id
   AND e.origin='PAYMENT' AND e."startsAt" = s."currentPeriodStart" AND e."endsAt" = s."currentPeriodEnd")
 AND NOT EXISTS (SELECT 1 FROM "SubscriptionEntitlement" e WHERE e."subscriptionId" = s.id
   AND e.origin='ADMIN_GRANT' AND e."startsAt" = s."currentPeriodStart" AND e."endsAt" = s."currentPeriodEnd");
-- Prove continuous coverage of the exact persisted current period. An older right
-- elsewhere in the subscription history is not enough. Adjacent and overlapping
-- intervals form coverage; any gap fails closed. Payment evidence remains bound
-- to this subscription and must still be financially valid.
CREATE FUNCTION kalend_subscription_period_covered(sub_id uuid, target_start timestamp, target_end timestamp)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE evidence AS (
    SELECT e."startsAt", e."endsAt"
    FROM "SubscriptionEntitlement" e
    JOIN "Subscription" s ON s.id=e."subscriptionId"
    WHERE e."subscriptionId"=sub_id AND e."revokedAt" IS NULL
      AND e."endsAt" > e."startsAt"
      AND (
        e.origin='ADMIN_GRANT'
        OR (e.origin='PAYMENT' AND EXISTS (SELECT 1 FROM "PaymentEvidence" pe
          JOIN "Payment" p ON p.id=pe."paymentId"
          WHERE pe."entitlementId"=e.id AND pe.status='APPLIED'
          AND pe."subscriptionId"=s.id AND pe."companyId"=s."companyId"
          AND pe."startsAt"=e."startsAt" AND pe."endsAt"=e."endsAt"
          AND p."subscriptionId"=s.id
          AND p."companyId"=s."companyId" AND p."planId"=s."planId"
          AND p."billingInterval"=s."billingInterval" AND p.currency=s.currency
          AND p.status='APPROVED' AND p."paidAt" IS NOT NULL
          AND p."amountCents" > p."refundedAmountCents"))
      )
  ), coverage(frontier) AS (
    SELECT e."endsAt"
    FROM evidence e
    WHERE e."startsAt" <= target_start AND e."endsAt" > target_start
    UNION
    SELECT e."endsAt"
    FROM coverage c JOIN evidence e
      ON e."startsAt" <= c.frontier AND e."endsAt" > c.frontier
    WHERE c.frontier < target_end
  )
  SELECT target_start IS NOT NULL AND target_end > target_start
    AND EXISTS (SELECT 1 FROM coverage WHERE frontier >= target_end)
$$;

-- An active period with a NULL boundary is ambiguous, not an infinite grant.
-- PAST_DUE without a current period or future grace has no current entitlement;
-- when either claim exists, however, both paid-period coverage and any positive
-- grace must be proven independently.
DO $$ DECLARE observed_at timestamp := clock_timestamp() AT TIME ZONE 'UTC'; BEGIN
  IF EXISTS (
    SELECT 1 FROM "Subscription" s
    WHERE s.status IN ('ACTIVE','PAST_DUE')
      AND (
        (s.status='ACTIVE' AND (s."currentPeriodEnd" IS NULL OR s."currentPeriodEnd" > observed_at))
        OR (s.status='PAST_DUE' AND (s."currentPeriodEnd" > observed_at OR s."graceEndsAt" > observed_at))
      )
      AND (
        s."currentPeriodStart" IS NULL OR s."currentPeriodEnd" IS NULL
        OR s."currentPeriodEnd" <= s."currentPeriodStart"
        OR NOT kalend_subscription_period_covered(s.id, s."currentPeriodStart", s."currentPeriodEnd")
        OR (s.status='PAST_DUE' AND s."graceEndsAt" > s."currentPeriodEnd"
          AND NOT EXISTS (
            SELECT 1 FROM "SubscriptionEntitlement" e
            WHERE e."subscriptionId"=s.id AND e."revokedAt" IS NULL
              AND e."endsAt"=s."currentPeriodEnd" AND e."graceEndsAt" >= s."graceEndsAt"
              AND ((e.origin='ADMIN_GRANT' AND NOT e.legacy)
                OR (e.origin='PAYMENT' AND EXISTS (SELECT 1 FROM "PaymentEvidence" pe
                  JOIN "Payment" p ON p.id=pe."paymentId"
                  WHERE pe."entitlementId"=e.id AND pe.status='APPLIED'
                    AND pe."subscriptionId"=s.id AND pe."companyId"=s."companyId"
                    AND p."subscriptionId"=s.id
                  AND p."companyId"=s."companyId" AND p."planId"=s."planId"
                  AND p."billingInterval"=s."billingInterval" AND p.currency=s.currency
                  AND p.status='APPROVED' AND p."paidAt" IS NOT NULL
                  AND p."amountCents" > p."refundedAmountCents")) )
          ))
      )
  ) THEN RAISE EXCEPTION 'ENTITLEMENT_BACKFILL_REQUIRES_REVIEW'; END IF;
END $$;

CREATE FUNCTION kalend_entitlement_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "Subscription";
BEGIN
  SELECT * INTO STRICT s FROM "Subscription" WHERE id=NEW."subscriptionId";
  IF TG_OP='INSERT' AND NEW.origin='ADMIN_GRANT' AND NOT NEW.legacy
    AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id=NEW."grantedById" AND u."isActive" AND u."isSuperAdmin")
  THEN RAISE EXCEPTION 'ADMIN_GRANT_FORBIDDEN'; END IF;
  IF NEW."revokedAt" IS NOT NULL AND (TG_OP='INSERT' OR OLD."revokedAt" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id=NEW."revokedById" AND u."isActive" AND u."isSuperAdmin")
  THEN RAISE EXCEPTION 'ADMIN_GRANT_REVOCATION_FORBIDDEN'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW."subscriptionId", NEW.origin, NEW."startsAt", NEW."endsAt", NEW."grantedById", NEW."grantedAt", NEW.legacy)
     IS DISTINCT FROM (OLD."subscriptionId", OLD.origin, OLD."startsAt", OLD."endsAt", OLD."grantedById", OLD."grantedAt", OLD.legacy)
  THEN RAISE EXCEPTION 'ENTITLEMENT_EVIDENCE_IMMUTABLE'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."revokedAt" IS NOT NULL AND (NEW."revokedAt", NEW."revokedById") IS DISTINCT FROM (OLD."revokedAt", OLD."revokedById")
  THEN RAISE EXCEPTION 'ENTITLEMENT_REVOCATION_IMMUTABLE'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."graceEndsAt" IS NOT NULL AND NEW."graceEndsAt" IS DISTINCT FROM OLD."graceEndsAt"
  THEN RAISE EXCEPTION 'ENTITLEMENT_GRACE_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entitlement_validate BEFORE INSERT OR UPDATE ON "SubscriptionEntitlement"
FOR EACH ROW EXECUTE FUNCTION kalend_entitlement_validate();

CREATE FUNCTION kalend_payment_evidence_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "Payment"; s "Subscription";
BEGIN
  SELECT * INTO STRICT p FROM "Payment" WHERE id=NEW."paymentId";
  SELECT * INTO STRICT s FROM "Subscription" WHERE id=NEW."subscriptionId";
  IF TG_OP='UPDATE' AND (NEW."paymentId",NEW."companyId",NEW."subscriptionId",NEW."entitlementId",NEW."startsAt",NEW."endsAt")
    IS DISTINCT FROM (OLD."paymentId",OLD."companyId",OLD."subscriptionId",OLD."entitlementId",OLD."startsAt",OLD."endsAt")
  THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_IMMUTABLE'; END IF;
  IF TG_OP='UPDATE' AND OLD.status='REVOKED' AND NEW.status='REVOKED'
    AND (NEW."revokedAt",NEW."reviewReason") IS DISTINCT FROM (OLD."revokedAt",OLD."reviewReason")
  THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_REVOCATION_IMMUTABLE'; END IF;
  IF p."subscriptionId" IS DISTINCT FROM s.id OR p."companyId"<>s."companyId"
    OR NEW."companyId"<>s."companyId" OR p."planId" IS DISTINCT FROM s."planId"
    OR p.currency<>s.currency OR p."billingInterval"<>s."billingInterval"
    OR p."periodStart" IS DISTINCT FROM NEW."startsAt" OR p."periodEnd" IS DISTINCT FROM NEW."endsAt"
  THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_SCOPE_MISMATCH'; END IF;
  IF NEW.status='APPLIED' AND (p.status<>'APPROVED' OR p."paidAt" IS NULL
    OR p."amountCents"<=p."refundedAmountCents" OR NEW."entitlementId" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "SubscriptionEntitlement" e WHERE e.id=NEW."entitlementId"
      AND e."subscriptionId"=s.id AND e.origin='PAYMENT'
      AND e."startsAt"=NEW."startsAt" AND e."endsAt"=NEW."endsAt"))
  THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_NOT_PROVEN'; END IF;
  IF NEW.status='APPLIED' AND EXISTS (
    SELECT 1 FROM "PaymentEvidence" prior WHERE prior.id<>NEW.id
      AND prior."entitlementId"=NEW."entitlementId" AND prior.status='APPLIED'
      AND prior."paymentId"<>NEW."paymentId"
  ) THEN
    NEW."financialReviewRequired" := true;
    NEW."reviewReason" := COALESCE(NEW."reviewReason", 'POSSIBLE_DUPLICATE_CHARGE');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_evidence_validate BEFORE INSERT OR UPDATE ON "PaymentEvidence"
FOR EACH ROW EXECUTE FUNCTION kalend_payment_evidence_validate();

CREATE FUNCTION kalend_payment_evidence_immutable_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PaymentEvidence" pe WHERE pe."paymentId"=NEW.id
    AND (pe."companyId" IS DISTINCT FROM NEW."companyId"
      OR pe."subscriptionId" IS DISTINCT FROM NEW."subscriptionId"
      OR pe."startsAt" IS DISTINCT FROM NEW."periodStart"
      OR pe."endsAt" IS DISTINCT FROM NEW."periodEnd"))
  THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_SCOPE_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_evidence_scope_immutable BEFORE UPDATE OF "companyId", "subscriptionId", "periodStart", "periodEnd"
ON "Payment" FOR EACH ROW EXECUTE FUNCTION kalend_payment_evidence_immutable_scope();

CREATE FUNCTION kalend_subscription_grace_entitled(sub_id uuid, deadline timestamp, observed_at timestamp)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM "SubscriptionEntitlement" e
 JOIN "Subscription" s ON s.id=e."subscriptionId"
 JOIN "Company" c ON c.id=s."companyId"
 WHERE s.id=sub_id AND c."administrativeStatus"='ACTIVE'
 AND e."revokedAt" IS NULL AND e."startsAt" <= observed_at AND e."endsAt" <= observed_at
 AND e."graceEndsAt" >= deadline AND deadline > observed_at
 AND (e.origin='ADMIN_GRANT' OR (e.origin='PAYMENT' AND EXISTS (
   SELECT 1 FROM "PaymentEvidence" pe JOIN "Payment" p ON p.id=pe."paymentId"
   WHERE pe."entitlementId"=e.id AND pe.status='APPLIED'
    AND pe."subscriptionId"=s.id AND pe."companyId"=s."companyId"
    AND p.status='APPROVED' AND p."paidAt" IS NOT NULL
    AND p."amountCents">p."refundedAmountCents"))))
$$;
CREATE OR REPLACE FUNCTION kalend_global_communication_capture() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  captured_at timestamp := clock_timestamp() AT TIME ZONE 'UTC';
  evt text;
  business_key text;
  company_id uuid;
  user_id uuid;
  vars jsonb := '{}'::jsonb;
BEGIN
  IF TG_TABLE_NAME = 'Payment' THEN
    IF TG_OP = 'UPDATE' AND NEW.status = OLD.status AND NEW."creationState" = OLD."creationState" THEN RETURN NEW; END IF;
    IF NEW.status::text NOT IN ('PENDING','APPROVED','FAILED','OVERDUE') THEN RETURN NEW; END IF;
    IF NEW.status::text = 'PENDING' AND NEW."creationState"::text <> 'CREATED' THEN RETURN NEW; END IF;
    evt := 'PAYMENT_' || NEW.status::text;
    business_key := evt || ':' || NEW.id::text;
    company_id := NEW."companyId";
    -- Payment has no reliable contractual due date. Do not invent vencimento from periodStart.
    vars := jsonb_build_object('valor', (NEW."amountCents"::numeric / 100)::text || ' ' || NEW.currency);
  ELSIF TG_TABLE_NAME = 'Subscription' THEN
    company_id := NEW."companyId";
    IF TG_OP = 'INSERT' THEN
      IF NEW.status::text <> 'TRIALING' THEN RETURN NEW; END IF;
      evt := 'TRIAL_STARTED';
    ELSE
      -- A new persisted grace window can begin while already PAST_DUE.
      IF NEW.status = OLD.status AND NOT (NEW.status::text = 'PAST_DUE'
        AND NEW."graceEndsAt" IS DISTINCT FROM OLD."graceEndsAt") THEN RETURN NEW; END IF;
      IF NEW.status::text = 'EXPIRED' AND OLD.status::text = 'TRIALING' AND NEW."trialEndsAt" <= captured_at THEN evt := 'TRIAL_EXPIRED';
      ELSIF NEW.status::text = 'PAST_DUE' AND kalend_subscription_grace_due(NEW."currentPeriodEnd", NEW."graceEndsAt", NEW."updatedAt", captured_at) AND kalend_subscription_grace_entitled(NEW.id, NEW."graceEndsAt", captured_at) THEN evt := 'SUBSCRIPTION_GRACE_PERIOD';
      ELSIF NEW.status::text = 'SUSPENDED' THEN evt := 'SUBSCRIPTION_SUSPENDED';
      ELSIF NEW.status::text = 'CANCELED' THEN evt := 'SUBSCRIPTION_CANCELLED';
      ELSIF NEW.status::text = 'ACTIVE' AND OLD.status::text IN ('PAST_DUE','SUSPENDED') THEN evt := 'SUBSCRIPTION_REACTIVATED';
      ELSE RETURN NEW;
      END IF;
    END IF;
    business_key := evt || ':' || NEW.id::text;
    IF evt = 'SUBSCRIPTION_GRACE_PERIOD' THEN
      business_key := business_key || ':' || NEW."graceEndsAt"::text;
    ELSIF evt = 'SUBSCRIPTION_SUSPENDED' THEN
      business_key := business_key || ':' || COALESCE(NEW."graceEndsAt", NEW."currentPeriodEnd", NEW."endedAt", NEW."updatedAt")::text;
    ELSIF evt LIKE 'SUBSCRIPTION_%' THEN business_key := business_key || ':' || txid_current()::text;
    END IF;
    IF evt LIKE 'TRIAL_%' THEN
      SELECT jsonb_build_object('plano', p.name, 'vencimento', NEW."trialEndsAt"::text, 'dias_trial', ceil(extract(epoch from (NEW."trialEndsAt" - NEW."trialStartedAt"))/86400)::text) INTO vars FROM "Plan" p WHERE p.id=NEW."planId";
    END IF;
  ELSIF TG_TABLE_NAME = 'Membership' THEN
    IF NEW.role::text <> 'OWNER' OR NOT NEW."isActive" THEN RETURN NEW; END IF;
    evt := 'OWNER_WELCOME'; company_id := NEW."companyId"; user_id := NEW."userId";
    business_key := evt || ':' || company_id::text || ':' || user_id::text;
  ELSIF TG_TABLE_NAME = 'User' THEN
    IF NEW."passwordHash" = OLD."passwordHash" THEN RETURN NEW; END IF;
    -- Never copy a password hash into the journal or idempotency key.
    evt := 'SECURITY_PASSWORD_CHANGED'; user_id := NEW.id;
    business_key := evt || ':' || user_id::text || ':' || txid_current()::text;
  ELSE RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'Subscription' THEN
    IF evt = 'SUBSCRIPTION_GRACE_PERIOD'
      AND kalend_subscription_legacy_grace_seen(NEW.id, company_id, COALESCE(NEW."currentPeriodStart",NEW."createdAt"),NEW."graceEndsAt") THEN
      RETURN NEW;
    END IF;
  END IF;
  INSERT INTO "GlobalCommunicationOutbox" (id, scope, event, "businessKey", "companyId", "userId", variables, "createdAt")
  VALUES (gen_random_uuid(), 'GLOBAL', evt, business_key, company_id, user_id, COALESCE(vars,'{}'::jsonb), captured_at)
  ON CONFLICT ("businessKey") DO NOTHING;
  RETURN NEW;
END;
$$;

COMMIT;
