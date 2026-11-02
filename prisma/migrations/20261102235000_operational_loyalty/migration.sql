-- CreateTable
CREATE TABLE "PosLoyaltySettings" (
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "spendCents" INTEGER NOT NULL DEFAULT 100,
    "points" INTEGER NOT NULL DEFAULT 1,
    "minPaidCents" INTEGER NOT NULL DEFAULT 100,
    "referralPoints" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosLoyaltySettings_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "PosLoyaltyCard" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "code" UUID NOT NULL,
    "referrerId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosLoyaltyCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosLoyaltyEntry" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "originalPoints" INTEGER NOT NULL,
    "basisCents" INTEGER NOT NULL,
    "minPaidCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosLoyaltyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosLoyaltyCard_code_key" ON "PosLoyaltyCard"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PosLoyaltyCard_id_companyId_key" ON "PosLoyaltyCard"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosLoyaltyCard_customerId_companyId_key" ON "PosLoyaltyCard"("customerId", "companyId");

-- CreateIndex
CREATE INDEX "PosLoyaltyEntry_companyId_cardId_idx" ON "PosLoyaltyEntry"("companyId", "cardId");

-- CreateIndex
CREATE UNIQUE INDEX "PosLoyaltyEntry_companyId_sourceKey_key" ON "PosLoyaltyEntry"("companyId", "sourceKey");

-- AddForeignKey
ALTER TABLE "PosLoyaltySettings" ADD CONSTRAINT "PosLoyaltySettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosLoyaltyCard" ADD CONSTRAINT "PosLoyaltyCard_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosLoyaltyCard" ADD CONSTRAINT "PosLoyaltyCard_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "CustomerProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosLoyaltyCard" ADD CONSTRAINT "PosLoyaltyCard_referrerId_companyId_fkey" FOREIGN KEY ("referrerId", "companyId") REFERENCES "PosLoyaltyCard"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosLoyaltyEntry" ADD CONSTRAINT "PosLoyaltyEntry_cardId_companyId_fkey" FOREIGN KEY ("cardId", "companyId") REFERENCES "PosLoyaltyCard"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosLoyaltyEntry" ADD CONSTRAINT "PosLoyaltyEntry_saleId_companyId_fkey" FOREIGN KEY ("saleId", "companyId") REFERENCES "PosSale"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PosLoyaltySettings" ADD CONSTRAINT "loyalty_valid_settings" CHECK ("spendCents">=100 AND points BETWEEN 1 AND 100 AND "minPaidCents">0 AND "referralPoints" BETWEEN 0 AND 10000);
ALTER TABLE "PosLoyaltyCard" ADD CONSTRAINT "loyalty_no_self_referral" CHECK ("referrerId" IS NULL OR "referrerId"<>id);
CREATE FUNCTION kalend_loyalty_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Loyalty ledger is immutable'; END $$;
CREATE TRIGGER loyalty_ledger_immutable BEFORE UPDATE OR DELETE ON "PosLoyaltyEntry" FOR EACH ROW EXECUTE FUNCTION kalend_loyalty_immutable();
