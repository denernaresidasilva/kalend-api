BEGIN;
-- Separate administrative authority from commercial entitlement. No history is rewritten.
CREATE TYPE "CompanyAdministrativeStatus" AS ENUM ('ACTIVE', 'DISABLED', 'LEGACY_UNKNOWN');
ALTER TABLE "Company" ADD COLUMN "administrativeStatus" "CompanyAdministrativeStatus" NOT NULL DEFAULT 'LEGACY_UNKNOWN';
-- Only unequivocally enabled companies are classified automatically.
UPDATE "Company" SET "administrativeStatus" = 'ACTIVE'
WHERE "isActive" = true AND status IN ('ACTIVE', 'TRIAL');
-- New companies use explicit administrative eligibility; ambiguous legacy rows stay quarantined.
ALTER TABLE "Company" ALTER COLUMN "administrativeStatus" SET DEFAULT 'ACTIVE';

-- Capture entry into a real grace window even when PAST_DUE status is unchanged.
-- Existing deterministic event keys and timing guards remain authoritative.
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
      ELSIF NEW.status::text = 'PAST_DUE' AND kalend_subscription_grace_due(NEW."currentPeriodEnd", NEW."graceEndsAt", NEW."updatedAt", captured_at) THEN evt := 'SUBSCRIPTION_GRACE_PERIOD';
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
