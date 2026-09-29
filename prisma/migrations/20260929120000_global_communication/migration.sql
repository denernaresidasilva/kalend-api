-- CreateEnum
CREATE TYPE "CommunicationScope" AS ENUM ('GLOBAL');

-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'PUSH');

-- CreateEnum
CREATE TYPE "CommunicationProvider" AS ENUM ('SMTP', 'GMAIL', 'META', 'EVOLUTION', 'PUSH_PENDING');

-- CreateEnum
CREATE TYPE "CommunicationDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'READ', 'RETRY', 'FAILED', 'UNSENDABLE', 'UNCERTAIN', 'SKIPPED');

-- CreateTable
CREATE TABLE "GlobalCommunicationProvider" (
    "provider" "CommunicationProvider" NOT NULL,
    "scope" "CommunicationScope" NOT NULL DEFAULT 'GLOBAL',
    "environment" "GatewayEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "credentialsEncrypted" TEXT,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalCommunicationProvider_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "GlobalCommunicationTemplate" (
    "id" UUID NOT NULL,
    "scope" "CommunicationScope" NOT NULL DEFAULT 'GLOBAL',
    "event" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "provider" "CommunicationProvider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "content" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalCommunicationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalCommunicationOutbox" (
    "id" UUID NOT NULL,
    "scope" "CommunicationScope" NOT NULL DEFAULT 'GLOBAL',
    "event" TEXT NOT NULL,
    "businessKey" TEXT NOT NULL,
    "companyId" UUID,
    "userId" UUID,
    "variables" JSONB NOT NULL,
    "lastError" TEXT,
    "expandedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalCommunicationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalCommunicationDelivery" (
    "id" UUID NOT NULL,
    "scope" "CommunicationScope" NOT NULL DEFAULT 'GLOBAL',
    "outboxId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "provider" "CommunicationProvider" NOT NULL,
    "environment" "GatewayEnvironment" NOT NULL,
    "configurationRevision" INTEGER NOT NULL,
    "templateId" UUID NOT NULL,
    "templateRevision" INTEGER NOT NULL,
    "recipientMasked" TEXT NOT NULL,
    "payloadEncrypted" TEXT,
    "status" "CommunicationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalCommunicationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalCommunicationLog" (
    "id" UUID NOT NULL,
    "scope" "CommunicationScope" NOT NULL DEFAULT 'GLOBAL',
    "deliveryId" UUID,
    "outboxId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "code" TEXT,
    "attempt" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalCommunicationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalCommunicationMetaTemplate" (
    "id" UUID NOT NULL,
    "scope" "CommunicationScope" NOT NULL DEFAULT 'GLOBAL',
    "environment" "GatewayEnvironment" NOT NULL,
    "businessAccountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalCommunicationMetaTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlobalCommunicationTemplate_event_channel_key" ON "GlobalCommunicationTemplate"("event", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalCommunicationOutbox_businessKey_key" ON "GlobalCommunicationOutbox"("businessKey");

-- CreateIndex
CREATE INDEX "GlobalCommunicationOutbox_expandedAt_createdAt_idx" ON "GlobalCommunicationOutbox"("expandedAt", "createdAt");

-- CreateIndex
CREATE INDEX "GlobalCommunicationDelivery_status_nextAttemptAt_idx" ON "GlobalCommunicationDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "GlobalCommunicationDelivery_provider_environment_providerMe_idx" ON "GlobalCommunicationDelivery"("provider", "environment", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalCommunicationDelivery_outboxId_userId_channel_key" ON "GlobalCommunicationDelivery"("outboxId", "userId", "channel");

-- CreateIndex
CREATE INDEX "GlobalCommunicationLog_createdAt_idx" ON "GlobalCommunicationLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalCommunicationMetaTemplate_environment_businessAccount_key" ON "GlobalCommunicationMetaTemplate"("environment", "businessAccountId", "externalId");

-- AddForeignKey
ALTER TABLE "GlobalCommunicationDelivery" ADD CONSTRAINT "GlobalCommunicationDelivery_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "GlobalCommunicationOutbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalCommunicationLog" ADD CONSTRAINT "GlobalCommunicationLog_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "GlobalCommunicationDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Capture only durable domain facts. No network calls, secrets or template processing.
-- No backfill: installing communication must not send historical notifications.
CREATE FUNCTION kalend_global_communication_capture() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
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
      IF NEW.status::text = 'EXPIRED' AND OLD.status::text = 'TRIALING' AND NEW."trialEndsAt" <= CURRENT_TIMESTAMP THEN evt := 'TRIAL_EXPIRED';
      ELSIF NEW.status::text = 'PAST_DUE' AND NEW."graceEndsAt" > CURRENT_TIMESTAMP THEN evt := 'SUBSCRIPTION_GRACE_PERIOD';
      ELSIF NEW.status::text = 'SUSPENDED' THEN evt := 'SUBSCRIPTION_SUSPENDED';
      ELSIF NEW.status::text = 'CANCELED' THEN evt := 'SUBSCRIPTION_CANCELLED';
      ELSIF NEW.status::text = 'ACTIVE' AND OLD.status::text IN ('PAST_DUE','SUSPENDED') THEN evt := 'SUBSCRIPTION_REACTIVATED';
      ELSE RETURN NEW;
      END IF;
    END IF;
    business_key := evt || ':' || NEW.id::text;
    IF evt LIKE 'SUBSCRIPTION_%' THEN business_key := business_key || ':' || txid_current()::text; END IF;
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
  INSERT INTO "GlobalCommunicationOutbox" (id, scope, event, "businessKey", "companyId", "userId", variables, "createdAt")
  VALUES (gen_random_uuid(), 'GLOBAL', evt, business_key, company_id, user_id, COALESCE(vars,'{}'::jsonb), CURRENT_TIMESTAMP)
  ON CONFLICT ("businessKey") DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kalend_communication_payment AFTER INSERT OR UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION kalend_global_communication_capture();
CREATE TRIGGER kalend_communication_subscription AFTER INSERT OR UPDATE ON "Subscription" FOR EACH ROW EXECUTE FUNCTION kalend_global_communication_capture();
CREATE TRIGGER kalend_communication_owner AFTER INSERT ON "Membership" FOR EACH ROW EXECUTE FUNCTION kalend_global_communication_capture();
CREATE TRIGGER kalend_communication_password AFTER UPDATE OF "passwordHash" ON "User" FOR EACH ROW EXECUTE FUNCTION kalend_global_communication_capture();
