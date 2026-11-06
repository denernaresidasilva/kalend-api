-- AlterEnum
ALTER TYPE "PosPaymentMethod" ADD VALUE 'GIFT_CARD';

-- CreateTable
CREATE TABLE "PosGiftCard" (
    "productId" UUID NOT NULL,
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "sourceSaleId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeEncrypted" TEXT NOT NULL,
    "suffix" TEXT NOT NULL,
    "faceCents" INTEGER NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "validityDays" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosGiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosGiftCardMovement" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "type" TEXT NOT NULL,
    "deltaCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "receiptId" UUID,
    "refundId" UUID,
    "actorId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosGiftCardMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCard_productId_key" ON "PosGiftCard"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCard_sourceSaleId_key" ON "PosGiftCard"("sourceSaleId");

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCard_codeHash_key" ON "PosGiftCard"("codeHash");

-- CreateIndex
CREATE INDEX "PosGiftCard_companyId_recipientId_status_idx" ON "PosGiftCard"("companyId", "recipientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCard_id_companyId_key" ON "PosGiftCard"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCard_productId_companyId_key" ON "PosGiftCard"("productId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCard_sourceSaleId_companyId_key" ON "PosGiftCard"("sourceSaleId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCardMovement_receiptId_key" ON "PosGiftCardMovement"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCardMovement_refundId_key" ON "PosGiftCardMovement"("refundId");

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCardMovement_companyId_sourceKey_key" ON "PosGiftCardMovement"("companyId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCardMovement_receiptId_companyId_key" ON "PosGiftCardMovement"("receiptId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosGiftCardMovement_refundId_companyId_key" ON "PosGiftCardMovement"("refundId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosRefund_id_companyId_key" ON "PosRefund"("id", "companyId");

-- AddForeignKey
ALTER TABLE "PosGiftCard" ADD CONSTRAINT "PosGiftCard_productId_companyId_fkey" FOREIGN KEY ("productId", "companyId") REFERENCES "PosProduct"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosGiftCard" ADD CONSTRAINT "PosGiftCard_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosGiftCard" ADD CONSTRAINT "PosGiftCard_sourceSaleId_companyId_fkey" FOREIGN KEY ("sourceSaleId", "companyId") REFERENCES "PosSale"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosGiftCard" ADD CONSTRAINT "PosGiftCard_recipientId_companyId_fkey" FOREIGN KEY ("recipientId", "companyId") REFERENCES "CustomerProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosGiftCardMovement" ADD CONSTRAINT "PosGiftCardMovement_cardId_companyId_fkey" FOREIGN KEY ("cardId", "companyId") REFERENCES "PosGiftCard"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosGiftCardMovement" ADD CONSTRAINT "PosGiftCardMovement_receiptId_companyId_fkey" FOREIGN KEY ("receiptId", "companyId") REFERENCES "PosReceipt"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosGiftCardMovement" ADD CONSTRAINT "PosGiftCardMovement_refundId_companyId_fkey" FOREIGN KEY ("refundId", "companyId") REFERENCES "PosRefund"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "PosGiftCard" ADD CONSTRAINT "gift_card_money_status" CHECK ("faceCents">0 AND "balanceCents" BETWEEN 0 AND "faceCents" AND "validityDays" BETWEEN 1 AND 3650 AND status IN ('PENDING','ACTIVE','CANCELLED') AND (status!='ACTIVE' OR ("creditedAt" IS NOT NULL AND "expiresAt">"creditedAt")));
ALTER TABLE "PosGiftCardMovement" ADD CONSTRAINT "gift_movement_value" CHECK ("balanceAfterCents">=0 AND ((type IN ('CREDIT','RESTORE') AND "deltaCents">0) OR (type IN ('REDEEM','SOURCE_REFUND') AND "deltaCents"<0)));
CREATE TRIGGER gift_card_movement_immutable BEFORE UPDATE OR DELETE ON "PosGiftCardMovement" FOR EACH ROW EXECUTE FUNCTION kalend_package_immutable();
