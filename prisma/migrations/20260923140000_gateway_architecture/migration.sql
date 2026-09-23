-- Additive migration. Existing migrations and historical payments are preserved.
-- Unique indexes intentionally fail on duplicate historical references: reconcile explicitly before deployment.
CREATE TYPE "GatewayEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'PENDING_VALIDATION', 'CONNECTED', 'FAILED');
CREATE TABLE "GatewayConfiguration" (
  "gateway" "PaymentGateway" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "environment" "GatewayEnvironment" NOT NULL DEFAULT 'SANDBOX',
  "publicId" TEXT,
  "credentialsEncrypted" TEXT,
  "webhookSecretEncrypted" TEXT,
  "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "lastValidatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GatewayConfiguration_pkey" PRIMARY KEY ("gateway")
);
ALTER TABLE "Payment" ADD COLUMN "planId" UUID,
  ADD COLUMN "environment" "GatewayEnvironment",
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'BRL',
  ADD COLUMN "periodStart" TIMESTAMP(3),
  ADD COLUMN "periodEnd" TIMESTAMP(3);
ALTER TABLE "WebhookEvent" ADD COLUMN "companyId" UUID,
  ADD COLUMN "environment" "GatewayEnvironment",
  ADD COLUMN "paymentId" UUID,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");
CREATE UNIQUE INDEX "Payment_gateway_externalPaymentId_key" ON "Payment"("gateway", "externalPaymentId");
CREATE UNIQUE INDEX "Subscription_gateway_externalSubscriptionId_key" ON "Subscription"("gateway", "externalSubscriptionId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
