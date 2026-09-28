-- CreateEnum
CREATE TYPE "PaymentCreationState" AS ENUM ('READY', 'CREATING', 'CREATED', 'UNCERTAIN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SubscriptionStatus" ADD VALUE 'PENDING';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'SUSPENDED';

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'OVERDUE';

-- AlterEnum
ALTER TYPE "PaymentGateway" ADD VALUE 'ASAAS';

-- DropIndex
DROP INDEX "Subscription_gateway_externalSubscriptionId_key";

-- DropIndex
DROP INDEX "Payment_gateway_externalPaymentId_key";

-- DropIndex
DROP INDEX "WebhookEvent_gateway_externalEventId_key";

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxMessages" INTEGER;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancellationRequestedAt" TIMESTAMP(3),
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'BRL',
ADD COLUMN     "environment" "GatewayEnvironment",
ADD COLUMN     "expectedAmountCents" INTEGER,
ADD COLUMN     "graceEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "billingInterval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "checkoutUrl" TEXT,
ADD COLUMN     "creationStartedAt" TIMESTAMP(3),
ADD COLUMN     "creationState" "PaymentCreationState" NOT NULL DEFAULT 'READY',
ADD COLUMN     "externalCheckoutId" TEXT,
ADD COLUMN     "recurring" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refundedAmountCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "GatewayConfiguration" ADD COLUMN     "recurringCredentialsEncrypted" TEXT,
ADD COLUMN     "recurringEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_gateway_environment_externalSubscriptionId_key" ON "Subscription"("gateway", "environment", "externalSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_gateway_environment_externalPaymentId_key" ON "Payment"("gateway", "environment", "externalPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_gateway_environment_externalEventId_key" ON "WebhookEvent"("gateway", "environment", "externalEventId");

-- Preserve known legacy intervals; never infer plan or environment from amount.
UPDATE "Payment" AS p SET "billingInterval" = s."billingInterval"
FROM "Subscription" AS s WHERE p."subscriptionId" = s."id";

-- Historic operations must never become automatically retryable external charges.
UPDATE "Payment" SET "creationState" = CASE
  WHEN "externalPaymentId" IS NOT NULL OR "gateway" = 'MANUAL'
    THEN 'CREATED'::"PaymentCreationState"
  ELSE 'UNCERTAIN'::"PaymentCreationState" END;
UPDATE "Payment" SET "refundedAmountCents" = "amountCents"
WHERE "status" = 'REFUNDED';
