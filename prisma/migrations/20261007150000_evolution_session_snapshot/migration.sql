-- Additive: no remote operations, no reassignment of existing instances.
ALTER TABLE "EvolutionConnection"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "codeEncrypted" TEXT,
ADD COLUMN "pairingPhoneEncrypted" TEXT,
ADD COLUMN "attemptStartedAt" TIMESTAMP(3),
ADD COLUMN "attemptExpiresAt" TIMESTAMP(3),
ADD COLUMN "lastConnectionEventAt" TIMESTAMP(3),
ADD COLUMN "disconnectReason" INTEGER,
ADD COLUMN "provisionRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "provisionRetryAt" TIMESTAMP(3);

-- Preserve ordering across the upgrade: the previous receiver used this clock for both event types.
UPDATE "EvolutionConnection" SET
  "lastConnectionEventAt" = "lastWebhookAt",
  "attemptExpiresAt" = CASE WHEN "connectionRequested" THEN (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes' ELSE NULL END
WHERE "lastWebhookAt" IS NOT NULL OR "connectionRequested";

CREATE INDEX "EvolutionConnection_codeExpiresAt_idx" ON "EvolutionConnection"("codeExpiresAt");
CREATE INDEX "EvolutionConnection_attemptExpiresAt_idx" ON "EvolutionConnection"("attemptExpiresAt");
CREATE INDEX "EvolutionConnection_provisionRequested_provisionRetryAt_idx" ON "EvolutionConnection"("provisionRequested", "provisionRetryAt");
