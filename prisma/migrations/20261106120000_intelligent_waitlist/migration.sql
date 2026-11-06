-- CreateTable
CREATE TABLE "WaitlistSettings" (
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "opportunityMinutes" INTEGER NOT NULL DEFAULT 30,
    "cancelOnConfirmation" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitlistSettings_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "professionalId" UUID,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "weekdays" INTEGER[],
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consentedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistOpportunity" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OFFERED',
    "requestId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaitlistEntry_companyId_status_createdAt_idx" ON "WaitlistEntry"("companyId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_id_companyId_key" ON "WaitlistEntry"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_companyId_idempotencyKey_key" ON "WaitlistEntry"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistOpportunity_requestId_key" ON "WaitlistOpportunity"("requestId");

-- CreateIndex
CREATE INDEX "WaitlistOpportunity_companyId_status_expiresAt_idx" ON "WaitlistOpportunity"("companyId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistOpportunity_id_companyId_key" ON "WaitlistOpportunity"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistOpportunity_requestId_companyId_key" ON "WaitlistOpportunity"("requestId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistOpportunity_entryId_professionalId_startsAt_key" ON "WaitlistOpportunity"("entryId", "professionalId", "startsAt");

-- AddForeignKey
ALTER TABLE "WaitlistSettings" ADD CONSTRAINT "WaitlistSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "CustomerProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_serviceId_companyId_fkey" FOREIGN KEY ("serviceId", "companyId") REFERENCES "Service"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_professionalId_companyId_fkey" FOREIGN KEY ("professionalId", "companyId") REFERENCES "ProfessionalProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistOpportunity" ADD CONSTRAINT "WaitlistOpportunity_entryId_companyId_fkey" FOREIGN KEY ("entryId", "companyId") REFERENCES "WaitlistEntry"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistOpportunity" ADD CONSTRAINT "WaitlistOpportunity_professionalId_companyId_fkey" FOREIGN KEY ("professionalId", "companyId") REFERENCES "ProfessionalProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistOpportunity" ADD CONSTRAINT "WaitlistOpportunity_requestId_companyId_fkey" FOREIGN KEY ("requestId", "companyId") REFERENCES "BookingRequest"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WaitlistSettings" ADD CONSTRAINT "waitlist_settings_bounds" CHECK ("opportunityMinutes" BETWEEN 5 AND 1440);
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "waitlist_time_bounds" CHECK ("startMinute">=0 AND "endMinute"<=1440 AND "startMinute"<"endMinute" AND status IN ('WAITING','CANCELLED','FULFILLED','EXPIRED'));
ALTER TABLE "WaitlistOpportunity" ADD CONSTRAINT "waitlist_offer_status" CHECK (status IN ('OFFERED','REQUESTED','CONVERTED','REJECTED','CANCELLED','EXPIRED'));
CREATE UNIQUE INDEX "waitlist_one_live_offer_per_entry" ON "WaitlistOpportunity"("entryId") WHERE status IN ('OFFERED','REQUESTED');
