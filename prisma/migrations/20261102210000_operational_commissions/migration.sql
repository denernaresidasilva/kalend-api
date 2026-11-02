BEGIN;
-- CreateEnum
CREATE TYPE "PosCommissionStatus" AS ENUM ('GENERATED', 'PAYABLE', 'PAID', 'REVERSED');

-- CreateTable
CREATE TABLE "PosCommissionRule" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "percentBps" INTEGER,
    "fixedCents" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosCommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosCommission" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "baseCents" INTEGER NOT NULL,
    "originalCents" INTEGER NOT NULL,
    "adjustmentCents" INTEGER NOT NULL DEFAULT 0,
    "amountCents" INTEGER NOT NULL,
    "ruleSnapshot" JSONB NOT NULL,
    "status" "PosCommissionStatus" NOT NULL DEFAULT 'GENERATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedById" UUID,

    CONSTRAINT "PosCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosCommissionAdjustment" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "commissionId" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "deltaCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosCommissionAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosCommissionPayout" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "commissionId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" "PosPaymentMethod" NOT NULL,
    "reference" TEXT NOT NULL,
    "cashSessionId" UUID,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosCommissionPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosCommissionRule_companyId_idx" ON "PosCommissionRule"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosCommissionRule_professionalId_serviceId_companyId_key" ON "PosCommissionRule"("professionalId", "serviceId", "companyId");

-- CreateIndex
CREATE INDEX "PosCommission_companyId_professionalId_status_idx" ON "PosCommission"("companyId", "professionalId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PosCommission_id_companyId_key" ON "PosCommission"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosCommission_lineId_companyId_key" ON "PosCommission"("lineId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosCommissionAdjustment_companyId_sourceKey_key" ON "PosCommissionAdjustment"("companyId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "PosCommissionPayout_companyId_idempotencyKey_key" ON "PosCommissionPayout"("companyId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "PosCommissionRule" ADD CONSTRAINT "PosCommissionRule_professionalId_companyId_fkey" FOREIGN KEY ("professionalId", "companyId") REFERENCES "ProfessionalProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCommissionRule" ADD CONSTRAINT "PosCommissionRule_serviceId_companyId_fkey" FOREIGN KEY ("serviceId", "companyId") REFERENCES "Service"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCommission" ADD CONSTRAINT "PosCommission_saleId_companyId_fkey" FOREIGN KEY ("saleId", "companyId") REFERENCES "PosSale"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCommission" ADD CONSTRAINT "PosCommission_lineId_companyId_fkey" FOREIGN KEY ("lineId", "companyId") REFERENCES "PosSaleLine"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCommission" ADD CONSTRAINT "PosCommission_professionalId_companyId_fkey" FOREIGN KEY ("professionalId", "companyId") REFERENCES "ProfessionalProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCommissionAdjustment" ADD CONSTRAINT "PosCommissionAdjustment_commissionId_companyId_fkey" FOREIGN KEY ("commissionId", "companyId") REFERENCES "PosCommission"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCommissionPayout" ADD CONSTRAINT "PosCommissionPayout_commissionId_companyId_fkey" FOREIGN KEY ("commissionId", "companyId") REFERENCES "PosCommission"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCommissionPayout" ADD CONSTRAINT "PosCommissionPayout_cashSessionId_companyId_fkey" FOREIGN KEY ("cashSessionId", "companyId") REFERENCES "PosCashSession"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "PosCommissionRule" ADD CONSTRAINT "PosCommissionRule_rate" CHECK (("percentBps" IS NOT NULL)::int + ("fixedCents" IS NOT NULL)::int = 1 AND ("percentBps" IS NULL OR "percentBps" BETWEEN 0 AND 10000) AND ("fixedCents" IS NULL OR "fixedCents" >= 0));
ALTER TABLE "PosCommission" ADD CONSTRAINT "PosCommission_amount" CHECK ("baseCents" >= 0 AND "originalCents" >= 0 AND "amountCents" >= 0 AND "originalCents" + "adjustmentCents" BETWEEN 0 AND "baseCents");
ALTER TABLE "PosCommissionPayout" ADD CONSTRAINT "PosCommissionPayout_positive" CHECK ("amountCents" > 0 AND (method <> 'CASH' OR "cashSessionId" IS NOT NULL));
CREATE TRIGGER "PosCommissionAdjustment_append_only" BEFORE UPDATE OR DELETE ON "PosCommissionAdjustment" FOR EACH ROW EXECUTE FUNCTION kalend_pos_immutable_entry();
CREATE TRIGGER "PosCommissionPayout_append_only" BEFORE UPDATE OR DELETE ON "PosCommissionPayout" FOR EACH ROW EXECUTE FUNCTION kalend_pos_immutable_entry();
ALTER TABLE "PosCommissionAdjustment" ADD COLUMN "requestHash" TEXT;
COMMIT;
