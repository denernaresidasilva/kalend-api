BEGIN;
-- CreateEnum
CREATE TYPE "PosSaleStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'AWAITING_PAYMENT', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PosPaymentMethod" AS ENUM ('CASH', 'PIX', 'DEBIT_CARD', 'CREDIT_CARD', 'TRANSFER', 'OTHER');

-- CreateTable
CREATE TABLE "PosCashSession" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "openingCents" INTEGER NOT NULL,
    "expectedCents" INTEGER,
    "countedCents" INTEGER,
    "differenceCents" INTEGER,
    "openedById" UUID NOT NULL,
    "closedById" UUID,
    "closingNote" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PosCashSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosProduct" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosCoupon" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "percentBps" INTEGER,
    "fixedCents" INTEGER,
    "minSubtotalCents" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSale" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "bookingRequestId" UUID,
    "customerId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "PosSaleStatus" NOT NULL DEFAULT 'OPEN',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "couponId" UUID,
    "openedById" UUID NOT NULL,
    "finalizedById" UUID,
    "cancelledById" UUID,
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finalizedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "PosSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSaleLine" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "bookingItemId" UUID,
    "serviceId" UUID,
    "productId" UUID,
    "professionalId" UUID,
    "name" TEXT NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosSaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosReceipt" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "cashSessionId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" "PosPaymentMethod" NOT NULL,
    "reference" TEXT,
    "recordedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosRefund" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "cashSessionId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosAudit" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "saleId" UUID,
    "actorId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosCashSession_companyId_openedAt_idx" ON "PosCashSession"("companyId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PosCashSession_id_companyId_key" ON "PosCashSession"("id", "companyId");

-- CreateIndex
CREATE INDEX "PosProduct_companyId_active_idx" ON "PosProduct"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PosProduct_id_companyId_key" ON "PosProduct"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosCoupon_id_companyId_key" ON "PosCoupon"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosCoupon_companyId_code_key" ON "PosCoupon"("companyId", "code");

-- CreateIndex
CREATE INDEX "PosSale_companyId_status_createdAt_idx" ON "PosSale"("companyId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_id_companyId_key" ON "PosSale"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_companyId_idempotencyKey_key" ON "PosSale"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_bookingRequestId_companyId_key" ON "PosSale"("bookingRequestId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosSaleLine_bookingItemId_key" ON "PosSaleLine"("bookingItemId");

-- CreateIndex
CREATE INDEX "PosSaleLine_companyId_saleId_idx" ON "PosSaleLine"("companyId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "PosSaleLine_id_companyId_key" ON "PosSaleLine"("id", "companyId");

-- CreateIndex
CREATE INDEX "PosReceipt_companyId_saleId_idx" ON "PosReceipt"("companyId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "PosReceipt_id_companyId_key" ON "PosReceipt"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosReceipt_companyId_idempotencyKey_key" ON "PosReceipt"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PosRefund_companyId_saleId_idx" ON "PosRefund"("companyId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "PosRefund_companyId_idempotencyKey_key" ON "PosRefund"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PosAudit_companyId_createdAt_idx" ON "PosAudit"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "PosCashSession" ADD CONSTRAINT "PosCashSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosProduct" ADD CONSTRAINT "PosProduct_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCoupon" ADD CONSTRAINT "PosCoupon_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_bookingRequestId_companyId_fkey" FOREIGN KEY ("bookingRequestId", "companyId") REFERENCES "BookingRequest"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "CustomerProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_couponId_companyId_fkey" FOREIGN KEY ("couponId", "companyId") REFERENCES "PosCoupon"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSaleLine" ADD CONSTRAINT "PosSaleLine_saleId_companyId_fkey" FOREIGN KEY ("saleId", "companyId") REFERENCES "PosSale"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSaleLine" ADD CONSTRAINT "PosSaleLine_serviceId_companyId_fkey" FOREIGN KEY ("serviceId", "companyId") REFERENCES "Service"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSaleLine" ADD CONSTRAINT "PosSaleLine_productId_companyId_fkey" FOREIGN KEY ("productId", "companyId") REFERENCES "PosProduct"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSaleLine" ADD CONSTRAINT "PosSaleLine_professionalId_companyId_fkey" FOREIGN KEY ("professionalId", "companyId") REFERENCES "ProfessionalProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosReceipt" ADD CONSTRAINT "PosReceipt_saleId_companyId_fkey" FOREIGN KEY ("saleId", "companyId") REFERENCES "PosSale"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosReceipt" ADD CONSTRAINT "PosReceipt_cashSessionId_companyId_fkey" FOREIGN KEY ("cashSessionId", "companyId") REFERENCES "PosCashSession"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosRefund" ADD CONSTRAINT "PosRefund_saleId_companyId_fkey" FOREIGN KEY ("saleId", "companyId") REFERENCES "PosSale"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosRefund" ADD CONSTRAINT "PosRefund_receiptId_companyId_fkey" FOREIGN KEY ("receiptId", "companyId") REFERENCES "PosReceipt"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosRefund" ADD CONSTRAINT "PosRefund_cashSessionId_companyId_fkey" FOREIGN KEY ("cashSessionId", "companyId") REFERENCES "PosCashSession"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosAudit" ADD CONSTRAINT "PosAudit_saleId_companyId_fkey" FOREIGN KEY ("saleId", "companyId") REFERENCES "PosSale"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX "PosCashSession_one_open_per_company" ON "PosCashSession"("companyId") WHERE "closedAt" IS NULL;
ALTER TABLE "PosCashSession" ADD CONSTRAINT "PosCashSession_money" CHECK ("openingCents" >= 0 AND ("countedCents" IS NULL OR "countedCents" >= 0));
ALTER TABLE "PosProduct" ADD CONSTRAINT "PosProduct_price" CHECK ("priceCents" >= 0);
ALTER TABLE "PosCoupon" ADD CONSTRAINT "PosCoupon_rule" CHECK (("percentBps" IS NOT NULL)::int + ("fixedCents" IS NOT NULL)::int = 1 AND ("percentBps" IS NULL OR "percentBps" BETWEEN 1 AND 10000) AND ("fixedCents" IS NULL OR "fixedCents" > 0) AND "minSubtotalCents" >= 0 AND ("maxUses" IS NULL OR "maxUses" > 0));
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_money" CHECK ("subtotalCents" >= 0 AND "discountCents" BETWEEN 0 AND "subtotalCents" AND "totalCents" = "subtotalCents" - "discountCents");
ALTER TABLE "PosSaleLine" ADD CONSTRAINT "PosSaleLine_kind_money" CHECK (("serviceId" IS NOT NULL)::int + ("productId" IS NOT NULL)::int = 1 AND ("serviceId" IS NULL OR "professionalId" IS NOT NULL) AND "unitPriceCents" >= 0 AND "quantity" BETWEEN 1 AND 100 AND ("completedAt" IS NULL OR "startedAt" IS NOT NULL));
CREATE UNIQUE INDEX "BookingRequestItem_id_companyId_key" ON "BookingRequestItem"("id", "companyId");
ALTER TABLE "PosSaleLine" ADD CONSTRAINT "PosSaleLine_bookingItem_tenant_fk" FOREIGN KEY ("bookingItemId", "companyId") REFERENCES "BookingRequestItem"("id", "companyId") ON DELETE RESTRICT;
ALTER TABLE "PosReceipt" ADD CONSTRAINT "PosReceipt_positive" CHECK ("amountCents" > 0);
ALTER TABLE "PosRefund" ADD CONSTRAINT "PosRefund_positive" CHECK ("amountCents" > 0);
CREATE FUNCTION kalend_pos_immutable_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Operational financial entries are append-only' USING ERRCODE = '23514'; END; $$;
CREATE TRIGGER "PosReceipt_append_only" BEFORE UPDATE OR DELETE ON "PosReceipt" FOR EACH ROW EXECUTE FUNCTION kalend_pos_immutable_entry();
CREATE TRIGGER "PosRefund_append_only" BEFORE UPDATE OR DELETE ON "PosRefund" FOR EACH ROW EXECUTE FUNCTION kalend_pos_immutable_entry();
CREATE TRIGGER "PosAudit_append_only" BEFORE UPDATE OR DELETE ON "PosAudit" FOR EACH ROW EXECUTE FUNCTION kalend_pos_immutable_entry();
COMMIT;
