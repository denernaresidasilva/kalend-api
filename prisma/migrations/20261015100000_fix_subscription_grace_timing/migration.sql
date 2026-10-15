-- Correct temporal capture in place. No backfill, row updates, table or enum changes.
-- All instants use UTC to match Prisma's timestamp-without-time-zone columns.
-- A paid period is the contractual start of grace; without one, the persisted
-- PAST_DUE update is the start. A zero/negative window never means grace.
CREATE FUNCTION kalend_subscription_grace_due(
  period_end timestamp, grace_end timestamp, changed_at timestamp, observed_at timestamp
) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(grace_end > COALESCE(period_end, changed_at)
    AND COALESCE(period_end, changed_at) <= observed_at
    AND observed_at < grace_end, false);
$$;

-- Preserve already-captured legacy facts (whose key ended in txid), without
-- rewriting timestamps or backfilling. The paid-cycle floor separates renewals.
CREATE FUNCTION kalend_subscription_legacy_grace_seen(
  subscription_id uuid, company_id uuid, cycle_start timestamp, grace_end timestamp
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "GlobalCommunicationOutbox" o
    WHERE o."companyId" = company_id AND o.event = 'SUBSCRIPTION_GRACE_PERIOD'
      AND o."businessKey" ~ ('^(QA_SIMULATION:)?SUBSCRIPTION_GRACE_PERIOD:' || subscription_id::text || ':[0-9]+$')
      AND o."createdAt" >= cycle_start AND o."createdAt" <= grace_end);
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
      IF NEW.status = OLD.status THEN RETURN NEW; END IF;
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
