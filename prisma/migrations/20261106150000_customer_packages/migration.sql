-- CreateTable
CREATE TABLE "PosPackageDefinition" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "validityDays" INTEGER NOT NULL,
    "terms" TEXT NOT NULL,
    "refundPolicy" TEXT NOT NULL DEFAULT 'SUSPEND_ON_REFUND',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosPackageDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosPackageService" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "sessions" INTEGER NOT NULL,
    "listPriceCents" INTEGER NOT NULL,

    CONSTRAINT "PosPackageService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosPackageProfessional" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "packageServiceId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,

    CONSTRAINT "PosPackageProfessional_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosPackageWallet" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "sourceLineId" UUID NOT NULL,
    "sourceSaleId" UUID NOT NULL,
    "originalCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosPackageWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosPackageSession" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "valueCents" INTEGER NOT NULL,
    "eligibleProfessionalIds" UUID[],
    "state" TEXT NOT NULL DEFAULT 'AVAILABLE',

    CONSTRAINT "PosPackageSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosPackageUse" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "originalUnitPriceCents" INTEGER NOT NULL,
    "allocatedCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "PosPackageUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosPackageMovement" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "useId" UUID,
    "type" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "actorId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosPackageMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageDefinition_productId_key" ON "PosPackageDefinition"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageDefinition_productId_companyId_key" ON "PosPackageDefinition"("productId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageDefinition_id_companyId_key" ON "PosPackageDefinition"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageService_id_companyId_key" ON "PosPackageService"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageService_definitionId_serviceId_key" ON "PosPackageService"("definitionId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageProfessional_packageServiceId_professionalId_key" ON "PosPackageProfessional"("packageServiceId", "professionalId");

-- CreateIndex
CREATE INDEX "PosPackageWallet_companyId_customerId_status_idx" ON "PosPackageWallet"("companyId", "customerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageWallet_id_companyId_key" ON "PosPackageWallet"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageWallet_sourceLineId_companyId_key" ON "PosPackageWallet"("sourceLineId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageSession_id_companyId_key" ON "PosPackageSession"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageSession_walletId_ordinal_key" ON "PosPackageSession"("walletId", "ordinal");

-- CreateIndex
CREATE INDEX "PosPackageUse_companyId_saleId_status_idx" ON "PosPackageUse"("companyId", "saleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageUse_id_companyId_key" ON "PosPackageUse"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageUse_companyId_idempotencyKey_key" ON "PosPackageUse"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PosPackageMovement_companyId_sourceKey_key" ON "PosPackageMovement"("companyId", "sourceKey");

-- AddForeignKey
ALTER TABLE "PosPackageDefinition" ADD CONSTRAINT "PosPackageDefinition_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageDefinition" ADD CONSTRAINT "PosPackageDefinition_productId_companyId_fkey" FOREIGN KEY ("productId", "companyId") REFERENCES "PosProduct"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageService" ADD CONSTRAINT "PosPackageService_definitionId_companyId_fkey" FOREIGN KEY ("definitionId", "companyId") REFERENCES "PosPackageDefinition"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageService" ADD CONSTRAINT "PosPackageService_serviceId_companyId_fkey" FOREIGN KEY ("serviceId", "companyId") REFERENCES "Service"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageProfessional" ADD CONSTRAINT "PosPackageProfessional_packageServiceId_companyId_fkey" FOREIGN KEY ("packageServiceId", "companyId") REFERENCES "PosPackageService"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageProfessional" ADD CONSTRAINT "PosPackageProfessional_professionalId_companyId_fkey" FOREIGN KEY ("professionalId", "companyId") REFERENCES "ProfessionalProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageWallet" ADD CONSTRAINT "PosPackageWallet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageWallet" ADD CONSTRAINT "PosPackageWallet_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "CustomerProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageWallet" ADD CONSTRAINT "PosPackageWallet_definitionId_companyId_fkey" FOREIGN KEY ("definitionId", "companyId") REFERENCES "PosPackageDefinition"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageWallet" ADD CONSTRAINT "PosPackageWallet_sourceLineId_companyId_fkey" FOREIGN KEY ("sourceLineId", "companyId") REFERENCES "PosSaleLine"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageWallet" ADD CONSTRAINT "PosPackageWallet_sourceSaleId_companyId_fkey" FOREIGN KEY ("sourceSaleId", "companyId") REFERENCES "PosSale"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageSession" ADD CONSTRAINT "PosPackageSession_walletId_companyId_fkey" FOREIGN KEY ("walletId", "companyId") REFERENCES "PosPackageWallet"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageSession" ADD CONSTRAINT "PosPackageSession_serviceId_companyId_fkey" FOREIGN KEY ("serviceId", "companyId") REFERENCES "Service"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageUse" ADD CONSTRAINT "PosPackageUse_sessionId_companyId_fkey" FOREIGN KEY ("sessionId", "companyId") REFERENCES "PosPackageSession"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageUse" ADD CONSTRAINT "PosPackageUse_saleId_companyId_fkey" FOREIGN KEY ("saleId", "companyId") REFERENCES "PosSale"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageUse" ADD CONSTRAINT "PosPackageUse_lineId_companyId_fkey" FOREIGN KEY ("lineId", "companyId") REFERENCES "PosSaleLine"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageMovement" ADD CONSTRAINT "PosPackageMovement_walletId_companyId_fkey" FOREIGN KEY ("walletId", "companyId") REFERENCES "PosPackageWallet"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPackageMovement" ADD CONSTRAINT "PosPackageMovement_useId_companyId_fkey" FOREIGN KEY ("useId", "companyId") REFERENCES "PosPackageUse"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PosPackageDefinition" ADD CONSTRAINT "package_validity_bounds" CHECK ("validityDays" BETWEEN 1 AND 3650 AND "refundPolicy"='SUSPEND_ON_REFUND');
ALTER TABLE "PosPackageService" ADD CONSTRAINT "package_sessions_bounds" CHECK (sessions BETWEEN 1 AND 100 AND "listPriceCents">=0);
ALTER TABLE "PosPackageWallet" ADD CONSTRAINT "package_wallet_bounds" CHECK ("originalCents">0 AND status IN ('ACTIVE','SUSPENDED','CANCELLED'));
ALTER TABLE "PosPackageSession" ADD CONSTRAINT "package_session_state" CHECK ("valueCents">=0 AND state IN ('AVAILABLE','RESERVED','CONSUMED'));
ALTER TABLE "PosPackageUse" ADD CONSTRAINT "package_use_bounds" CHECK ("allocatedCents">=0 AND "originalUnitPriceCents">=0 AND status IN ('RESERVED','CONSUMED','RELEASED','REVERSED'));
CREATE UNIQUE INDEX "package_one_active_use_per_line" ON "PosPackageUse"("lineId") WHERE status IN ('RESERVED','CONSUMED');
CREATE UNIQUE INDEX "package_one_active_use_per_session" ON "PosPackageUse"("sessionId") WHERE status IN ('RESERVED','CONSUMED');
CREATE FUNCTION kalend_package_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Package movements are immutable'; END $$;
CREATE TRIGGER package_movement_immutable BEFORE UPDATE OR DELETE ON "PosPackageMovement" FOR EACH ROW EXECUTE FUNCTION kalend_package_immutable();
