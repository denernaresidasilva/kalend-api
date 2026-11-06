-- AlterTable
ALTER TABLE "BookingRequestItem" ADD COLUMN     "clientSubscriptionId" UUID,
ADD COLUMN     "subscriptionDiscountCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PosSaleLine" ADD COLUMN     "clientSubscriptionId" UUID,
ADD COLUMN     "subscriptionDiscountCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PosLoyaltyEntry" ADD COLUMN     "clientSubscriptionCycleId" UUID;

-- AlterTable
ALTER TABLE "PosPackageDefinition" ADD COLUMN     "cycleMonths" INTEGER,
ADD COLUMN     "discountBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'PACKAGE',
ADD COLUMN     "loyaltyBonusPoints" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PosPackageWallet" ADD COLUMN     "validFrom" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PosClientSubscription" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "suspensionReason" TEXT,
    "renewalMode" TEXT NOT NULL DEFAULT 'MANUAL_PDV',
    "nextRenewalAt" TIMESTAMP(3) NOT NULL,
    "fundedCycles" INTEGER NOT NULL DEFAULT 0,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosClientSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosClientSubscriptionCycle" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DUE',
    "sourceWalletId" UUID,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosClientSubscriptionCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosClientSubscriptionEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "type" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosClientSubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosClientSubscription_companyId_status_nextRenewalAt_idx" ON "PosClientSubscription"("companyId", "status", "nextRenewalAt");

-- CreateIndex
CREATE UNIQUE INDEX "PosClientSubscription_id_companyId_key" ON "PosClientSubscription"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosClientSubscription_companyId_customerId_definitionId_key" ON "PosClientSubscription"("companyId", "customerId", "definitionId");

-- CreateIndex
CREATE INDEX "PosClientSubscriptionCycle_companyId_startsAt_endsAt_status_idx" ON "PosClientSubscriptionCycle"("companyId", "startsAt", "endsAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PosClientSubscriptionCycle_id_companyId_key" ON "PosClientSubscriptionCycle"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosClientSubscriptionCycle_sourceWalletId_companyId_key" ON "PosClientSubscriptionCycle"("sourceWalletId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosClientSubscriptionCycle_subscriptionId_ordinal_key" ON "PosClientSubscriptionCycle"("subscriptionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "PosClientSubscriptionEvent_companyId_sourceKey_key" ON "PosClientSubscriptionEvent"("companyId", "sourceKey");

-- AddForeignKey
ALTER TABLE "BookingRequestItem" ADD CONSTRAINT "BookingRequestItem_clientSubscriptionId_companyId_fkey" FOREIGN KEY ("clientSubscriptionId", "companyId") REFERENCES "PosClientSubscription"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSaleLine" ADD CONSTRAINT "PosSaleLine_clientSubscriptionId_companyId_fkey" FOREIGN KEY ("clientSubscriptionId", "companyId") REFERENCES "PosClientSubscription"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosLoyaltyEntry" ADD CONSTRAINT "PosLoyaltyEntry_clientSubscriptionCycleId_companyId_fkey" FOREIGN KEY ("clientSubscriptionCycleId", "companyId") REFERENCES "PosClientSubscriptionCycle"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosClientSubscription" ADD CONSTRAINT "PosClientSubscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosClientSubscription" ADD CONSTRAINT "PosClientSubscription_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "CustomerProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosClientSubscription" ADD CONSTRAINT "PosClientSubscription_definitionId_companyId_fkey" FOREIGN KEY ("definitionId", "companyId") REFERENCES "PosPackageDefinition"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosClientSubscriptionCycle" ADD CONSTRAINT "PosClientSubscriptionCycle_subscriptionId_companyId_fkey" FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "PosClientSubscription"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosClientSubscriptionCycle" ADD CONSTRAINT "PosClientSubscriptionCycle_sourceWalletId_companyId_fkey" FOREIGN KEY ("sourceWalletId", "companyId") REFERENCES "PosPackageWallet"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosClientSubscriptionEvent" ADD CONSTRAINT "PosClientSubscriptionEvent_subscriptionId_companyId_fkey" FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "PosClientSubscription"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PosPackageDefinition" ADD CONSTRAINT "client_club_definition_rules" CHECK (kind IN ('PACKAGE','CLUB') AND "discountBps" BETWEEN 0 AND 10000 AND "loyaltyBonusPoints" BETWEEN 0 AND 10000 AND ((kind='CLUB' AND "cycleMonths" IS NOT NULL AND "cycleMonths" BETWEEN 1 AND 12) OR (kind='PACKAGE' AND "cycleMonths" IS NULL AND "discountBps"=0 AND "loyaltyBonusPoints"=0)));
ALTER TABLE "PosClientSubscription" ADD CONSTRAINT "client_subscription_manual_only" CHECK (status IN ('ACTIVE','SUSPENDED','CANCELLED') AND "renewalMode"='MANUAL_PDV' AND "fundedCycles">=0);
ALTER TABLE "PosClientSubscriptionCycle" ADD CONSTRAINT "client_cycle_payment_proof" CHECK ("ordinal">0 AND "startsAt"<"endsAt" AND status IN ('DUE','PAID','REFUND_REVIEW','CANCELLED') AND ((status IN ('PAID','REFUND_REVIEW') AND "sourceWalletId" IS NOT NULL AND "paidAt" IS NOT NULL) OR (status IN ('DUE','CANCELLED') AND "sourceWalletId" IS NULL AND "paidAt" IS NULL)));
CREATE TRIGGER client_subscription_event_immutable BEFORE UPDATE OR DELETE ON "PosClientSubscriptionEvent" FOR EACH ROW EXECUTE FUNCTION kalend_package_immutable();

ALTER TABLE "PosSaleLine" ADD CONSTRAINT "club_line_discount_nonnegative" CHECK ("subscriptionDiscountCents">=0 AND ("subscriptionDiscountCents"=0 OR "clientSubscriptionId" IS NOT NULL));
ALTER TABLE "BookingRequestItem" ADD CONSTRAINT "club_quote_discount_nonnegative" CHECK ("subscriptionDiscountCents">=0 AND ("subscriptionDiscountCents"=0 OR "clientSubscriptionId" IS NOT NULL));
