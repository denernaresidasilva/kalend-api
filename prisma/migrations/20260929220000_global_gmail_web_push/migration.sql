BEGIN;
-- Additive migration; old deliveries retain their USER target and deduplication.
ALTER TABLE "GlobalCommunicationDelivery" ADD COLUMN "targetKey" TEXT NOT NULL DEFAULT 'USER';
DROP INDEX "GlobalCommunicationDelivery_outboxId_userId_channel_key";
CREATE UNIQUE INDEX "GlobalCommunicationDelivery_target_key" ON "GlobalCommunicationDelivery" ("outboxId", "userId", channel, "targetKey");
CREATE TABLE "GlobalGmailOAuthState" (
  "stateHash" CHAR(64) PRIMARY KEY, "bindingHash" CHAR(64) NOT NULL, "codeVerifierEncrypted" TEXT NOT NULL,
  "actorId" UUID NOT NULL, "sessionId" UUID NOT NULL,
  "configurationRevision" INTEGER NOT NULL, "redirectUri" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "GlobalGmailOAuthState_expiresAt_idx" ON "GlobalGmailOAuthState" ("expiresAt");
CREATE TYPE "GlobalPushPlatform" AS ENUM ('WEB', 'ANDROID', 'IOS');
CREATE TABLE "GlobalPushSubscription" (
  id UUID PRIMARY KEY, scope "CommunicationScope" NOT NULL DEFAULT 'GLOBAL',
  "userId" UUID NOT NULL REFERENCES "User"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  provider TEXT NOT NULL DEFAULT 'WEB_PUSH', platform "GlobalPushPlatform" NOT NULL DEFAULT 'WEB',
  "endpointHash" CHAR(64) NOT NULL, "credentialsEncrypted" TEXT, "vapidPublicKey" TEXT NOT NULL,
  label TEXT, active BOOLEAN NOT NULL DEFAULT true, "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3), "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "GlobalPushSubscription_endpointHash_key" ON "GlobalPushSubscription" ("endpointHash");
CREATE INDEX "GlobalPushSubscription_userId_active_idx" ON "GlobalPushSubscription" ("userId", active);
CREATE INDEX "GlobalPushSubscription_active_expiresAt_idx" ON "GlobalPushSubscription" (active, "expiresAt");

COMMIT;
