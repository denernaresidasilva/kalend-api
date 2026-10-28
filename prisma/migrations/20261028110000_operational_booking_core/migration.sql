BEGIN;

-- CreateEnum
CREATE TYPE "BookingRequestStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "durationMinutes" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "public" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfessionalProfile" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfessionalProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfessionalAvailability" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ProfessionalAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceProfessional" (
    "companyId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,

    CONSTRAINT "ServiceProfessional_pkey" PRIMARY KEY ("serviceId","professionalId")
);

-- CreateTable
CREATE TABLE "CustomerProfile" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "status" "BookingRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "idempotencyKey" TEXT NOT NULL,
    "holdExpiresAt" TIMESTAMP(3) NOT NULL,
    "termsAcceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "termsVersion" TEXT NOT NULL,
    "privacyVersion" TEXT NOT NULL,
    "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "marketingConsentedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRequestItem" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "serviceName" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Service_companyId_active_public_category_idx" ON "Service"("companyId", "active", "public", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Service_id_companyId_key" ON "Service"("id", "companyId");

-- CreateIndex
CREATE INDEX "ProfessionalProfile_companyId_active_idx" ON "ProfessionalProfile"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ProfessionalProfile_id_companyId_key" ON "ProfessionalProfile"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfessionalProfile_membershipId_companyId_key" ON "ProfessionalProfile"("membershipId", "companyId");

-- CreateIndex
CREATE INDEX "ProfessionalAvailability_companyId_professionalId_weekday_a_idx" ON "ProfessionalAvailability"("companyId", "professionalId", "weekday", "active");

-- CreateIndex
CREATE INDEX "ServiceProfessional_companyId_professionalId_idx" ON "ServiceProfessional"("companyId", "professionalId");

-- CreateIndex
CREATE INDEX "CustomerProfile_companyId_phone_idx" ON "CustomerProfile"("companyId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfile_id_companyId_key" ON "CustomerProfile"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfile_companyId_email_key" ON "CustomerProfile"("companyId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfile_companyId_phone_key" ON "CustomerProfile"("companyId", "phone");

-- CreateIndex
CREATE INDEX "BookingRequest_companyId_status_createdAt_idx" ON "BookingRequest"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BookingRequest_status_holdExpiresAt_idx" ON "BookingRequest"("status", "holdExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_companyId_idempotencyKey_key" ON "BookingRequest"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_id_companyId_key" ON "BookingRequest"("id", "companyId");

-- CreateIndex
CREATE INDEX "BookingRequestItem_companyId_professionalId_startsAt_endsAt_idx" ON "BookingRequestItem"("companyId", "professionalId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "BookingRequestItem_companyId_requestId_idx" ON "BookingRequestItem"("companyId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_id_companyId_key" ON "Membership"("id", "companyId");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalProfile" ADD CONSTRAINT "ProfessionalProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalProfile" ADD CONSTRAINT "ProfessionalProfile_membershipId_companyId_fkey" FOREIGN KEY ("membershipId", "companyId") REFERENCES "Membership"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalAvailability" ADD CONSTRAINT "ProfessionalAvailability_professionalId_companyId_fkey" FOREIGN KEY ("professionalId", "companyId") REFERENCES "ProfessionalProfile"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceProfessional" ADD CONSTRAINT "ServiceProfessional_serviceId_companyId_fkey" FOREIGN KEY ("serviceId", "companyId") REFERENCES "Service"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceProfessional" ADD CONSTRAINT "ServiceProfessional_professionalId_companyId_fkey" FOREIGN KEY ("professionalId", "companyId") REFERENCES "ProfessionalProfile"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProfile" ADD CONSTRAINT "CustomerProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "CustomerProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequestItem" ADD CONSTRAINT "BookingRequestItem_requestId_companyId_fkey" FOREIGN KEY ("requestId", "companyId") REFERENCES "BookingRequest"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequestItem" ADD CONSTRAINT "BookingRequestItem_serviceId_companyId_fkey" FOREIGN KEY ("serviceId", "companyId") REFERENCES "Service"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequestItem" ADD CONSTRAINT "BookingRequestItem_professionalId_companyId_fkey" FOREIGN KEY ("professionalId", "companyId") REFERENCES "ProfessionalProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "Service" ADD CONSTRAINT "Service_duration_positive" CHECK ("durationMinutes" BETWEEN 1 AND 1440);
ALTER TABLE "Service" ADD CONSTRAINT "Service_price_nonnegative" CHECK ("priceCents" >= 0);
ALTER TABLE "ProfessionalAvailability" ADD CONSTRAINT "ProfessionalAvailability_weekday_range" CHECK ("weekday" BETWEEN 0 AND 6);
ALTER TABLE "ProfessionalAvailability" ADD CONSTRAINT "ProfessionalAvailability_minutes_range" CHECK ("startMinute" >= 0 AND "startMinute" < "endMinute" AND "endMinute" <= 1440);
ALTER TABLE "BookingRequestItem" ADD CONSTRAINT "BookingRequestItem_interval_valid" CHECK ("startsAt" < "endsAt" AND "priceCents" >= 0 AND "durationMinutes" > 0);

COMMIT;
