BEGIN;
-- AlterTable
ALTER TABLE "GlobalPushSubscription" ADD COLUMN     "environment" "GatewayEnvironment" NOT NULL DEFAULT 'SANDBOX',
ADD COLUMN     "lastUsedAt" TIMESTAMP(3);

-- Preserve existing devices in the provider environment, without granting tenant consent.
UPDATE "GlobalPushSubscription" SET "environment" = p."environment"
FROM "GlobalCommunicationProvider" p WHERE p.provider = 'PUSH_PENDING' AND p.scope = 'GLOBAL';

-- CreateTable
CREATE TABLE "GlobalPushAuthorization" (
    "subscriptionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalPushAuthorization_pkey" PRIMARY KEY ("subscriptionId","companyId")
);

-- CreateIndex
CREATE INDEX "GlobalPushAuthorization_userId_companyId_active_idx" ON "GlobalPushAuthorization"("userId", "companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalPushSubscription_id_userId_key" ON "GlobalPushSubscription"("id", "userId");

-- AddForeignKey
ALTER TABLE "GlobalPushAuthorization" ADD CONSTRAINT "GlobalPushAuthorization_subscriptionId_userId_fkey" FOREIGN KEY ("subscriptionId", "userId") REFERENCES "GlobalPushSubscription"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalPushAuthorization" ADD CONSTRAINT "GlobalPushAuthorization_userId_companyId_fkey" FOREIGN KEY ("userId", "companyId") REFERENCES "Membership"("userId", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
