BEGIN;
-- CreateTable
CREATE TABLE "PosMessageConsent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp" BOOLEAN NOT NULL DEFAULT false,
    "push" BOOLEAN NOT NULL DEFAULT false,
    "marketing" BOOLEAN NOT NULL DEFAULT false,
    "emailSnapshot" TEXT,
    "phoneSnapshot" TEXT,
    "actorId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosMessageConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosServiceFollowup" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "delayMinutes" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosServiceFollowup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosFollowupJob" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosFollowupJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosMessageConsent_customerId_companyId_key" ON "PosMessageConsent"("customerId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PosServiceFollowup_serviceId_companyId_key" ON "PosServiceFollowup"("serviceId", "companyId");

-- CreateIndex
CREATE INDEX "PosFollowupJob_status_dueAt_idx" ON "PosFollowupJob"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "PosFollowupJob_lineId_companyId_key" ON "PosFollowupJob"("lineId", "companyId");

-- AddForeignKey
ALTER TABLE "PosMessageConsent" ADD CONSTRAINT "PosMessageConsent_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "CustomerProfile"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosServiceFollowup" ADD CONSTRAINT "PosServiceFollowup_serviceId_companyId_fkey" FOREIGN KEY ("serviceId", "companyId") REFERENCES "Service"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosFollowupJob" ADD CONSTRAINT "PosFollowupJob_saleId_companyId_fkey" FOREIGN KEY ("saleId", "companyId") REFERENCES "PosSale"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosFollowupJob" ADD CONSTRAINT "PosFollowupJob_lineId_companyId_fkey" FOREIGN KEY ("lineId", "companyId") REFERENCES "PosSaleLine"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosFollowupJob" ADD CONSTRAINT "PosFollowupJob_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "CustomerProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "PosServiceFollowup" ADD CONSTRAINT "PosServiceFollowup_delay" CHECK ("delayMinutes" BETWEEN 1 AND 525600);
ALTER TABLE "PosFollowupJob" ADD CONSTRAINT "PosFollowupJob_status" CHECK (status IN ('PENDING','ENQUEUED','SKIPPED','CANCELLED'));
COMMIT;
