-- AlterTable
ALTER TABLE "PosProduct" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "categoryId" UUID,
ADD COLUMN     "costCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "location" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "minimumMilli" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stockManaged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stockMilli" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unit" TEXT NOT NULL DEFAULT 'UN';

-- CreateTable
CREATE TABLE "PosInventoryCategory" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "PosInventoryCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosInventorySupplier" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PosInventorySupplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosInventoryLot" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "supplierId" UUID,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "quantityMilli" INTEGER NOT NULL,
    "unitCostCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosInventoryLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosServiceMaterial" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantityMilli" INTEGER NOT NULL,

    CONSTRAINT "PosServiceMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosInventoryOperation" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosInventoryOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosInventoryMovement" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "lineId" UUID,
    "quantityMilli" INTEGER NOT NULL,
    "costMilliCents" BIGINT NOT NULL,
    "restoreOfId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosInventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosInventoryCategory_id_companyId_key" ON "PosInventoryCategory"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosInventoryCategory_companyId_name_key" ON "PosInventoryCategory"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PosInventorySupplier_id_companyId_key" ON "PosInventorySupplier"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosInventorySupplier_companyId_name_key" ON "PosInventorySupplier"("companyId", "name");

-- CreateIndex
CREATE INDEX "PosInventoryLot_companyId_productId_expiresAt_idx" ON "PosInventoryLot"("companyId", "productId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PosInventoryLot_id_companyId_key" ON "PosInventoryLot"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosServiceMaterial_companyId_serviceId_productId_key" ON "PosServiceMaterial"("companyId", "serviceId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "PosInventoryOperation_id_companyId_key" ON "PosInventoryOperation"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosInventoryOperation_companyId_sourceKey_key" ON "PosInventoryOperation"("companyId", "sourceKey");

-- CreateIndex
CREATE INDEX "PosInventoryMovement_companyId_lineId_idx" ON "PosInventoryMovement"("companyId", "lineId");

-- CreateIndex
CREATE UNIQUE INDEX "PosInventoryMovement_id_companyId_key" ON "PosInventoryMovement"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosProduct_companyId_barcode_key" ON "PosProduct"("companyId", "barcode");

-- AddForeignKey
ALTER TABLE "PosProduct" ADD CONSTRAINT "PosProduct_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "PosInventoryCategory"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosInventoryCategory" ADD CONSTRAINT "PosInventoryCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosInventorySupplier" ADD CONSTRAINT "PosInventorySupplier_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosInventoryLot" ADD CONSTRAINT "PosInventoryLot_productId_companyId_fkey" FOREIGN KEY ("productId", "companyId") REFERENCES "PosProduct"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosInventoryLot" ADD CONSTRAINT "PosInventoryLot_supplierId_companyId_fkey" FOREIGN KEY ("supplierId", "companyId") REFERENCES "PosInventorySupplier"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosServiceMaterial" ADD CONSTRAINT "PosServiceMaterial_serviceId_companyId_fkey" FOREIGN KEY ("serviceId", "companyId") REFERENCES "Service"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosServiceMaterial" ADD CONSTRAINT "PosServiceMaterial_productId_companyId_fkey" FOREIGN KEY ("productId", "companyId") REFERENCES "PosProduct"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosInventoryOperation" ADD CONSTRAINT "PosInventoryOperation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosInventoryMovement" ADD CONSTRAINT "PosInventoryMovement_operationId_companyId_fkey" FOREIGN KEY ("operationId", "companyId") REFERENCES "PosInventoryOperation"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosInventoryMovement" ADD CONSTRAINT "PosInventoryMovement_lotId_companyId_fkey" FOREIGN KEY ("lotId", "companyId") REFERENCES "PosInventoryLot"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosInventoryMovement" ADD CONSTRAINT "PosInventoryMovement_lineId_companyId_fkey" FOREIGN KEY ("lineId", "companyId") REFERENCES "PosSaleLine"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosInventoryMovement" ADD CONSTRAINT "PosInventoryMovement_restoreOfId_companyId_fkey" FOREIGN KEY ("restoreOfId", "companyId") REFERENCES "PosInventoryMovement"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "PosProduct" ADD CONSTRAINT "inventory_product_bounds" CHECK ("stockMilli" BETWEEN 0 AND 1000000000 AND "minimumMilli" BETWEEN 0 AND 1000000000 AND "costCents" BETWEEN 0 AND 100000000);
ALTER TABLE "PosInventoryLot" ADD CONSTRAINT "inventory_lot_bounds" CHECK ("quantityMilli" BETWEEN 0 AND 1000000000 AND "unitCostCents" BETWEEN 0 AND 100000000);
ALTER TABLE "PosServiceMaterial" ADD CONSTRAINT "service_material_positive" CHECK ("quantityMilli" BETWEEN 1 AND 100000000);
ALTER TABLE "PosInventoryMovement" ADD CONSTRAINT "inventory_movement_bounds" CHECK ("quantityMilli"!=0 AND (("quantityMilli">0 AND "costMilliCents">=0) OR ("quantityMilli"<0 AND "costMilliCents"<=0)) AND ("restoreOfId" IS NULL OR "quantityMilli">0));
CREATE TRIGGER inventory_operation_immutable BEFORE UPDATE OR DELETE ON "PosInventoryOperation" FOR EACH ROW EXECUTE FUNCTION kalend_package_immutable();
CREATE TRIGGER inventory_movement_immutable BEFORE UPDATE OR DELETE ON "PosInventoryMovement" FOR EACH ROW EXECUTE FUNCTION kalend_package_immutable();
