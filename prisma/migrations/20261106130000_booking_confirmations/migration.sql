-- CreateTable
CREATE TABLE "BookingConfirmationSettings" (
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "leadMinutes" INTEGER NOT NULL DEFAULT 1440,
    "responseMinutes" INTEGER NOT NULL DEFAULT 120,
    "reminderMinutes" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "channels" TEXT[] DEFAULT ARRAY['PUSH']::TEXT[],
    "noResponseRule" TEXT NOT NULL DEFAULT 'NONE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingConfirmationSettings_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "BookingConfirmation" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "response" TEXT,
    "responseAt" TIMESTAMP(3),
    "deadlineResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingConfirmationInvitation" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "confirmationId" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "action" TEXT,
    "outboxId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingConfirmationInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAttendanceEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "confirmationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "actorId" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingAttendanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingScheduleChange" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingScheduleChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingDepositPolicy" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "professionalId" UUID,
    "percentBps" INTEGER,
    "fixedCents" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingDepositPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingConfirmation_companyId_deadlineAt_idx" ON "BookingConfirmation"("companyId", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingConfirmation_id_companyId_key" ON "BookingConfirmation"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingConfirmation_requestId_companyId_key" ON "BookingConfirmation"("requestId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingConfirmationInvitation_tokenHash_key" ON "BookingConfirmationInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "BookingConfirmationInvitation_expiresAt_idx" ON "BookingConfirmationInvitation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingConfirmationInvitation_confirmationId_stage_key" ON "BookingConfirmationInvitation"("confirmationId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAttendanceEvent_companyId_sourceKey_key" ON "BookingAttendanceEvent"("companyId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "BookingScheduleChange_companyId_idempotencyKey_key" ON "BookingScheduleChange"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BookingDepositPolicy_companyId_serviceId_professionalId_key" ON "BookingDepositPolicy"("companyId", "serviceId", "professionalId");

-- AddForeignKey
ALTER TABLE "BookingConfirmationSettings" ADD CONSTRAINT "BookingConfirmationSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingConfirmation" ADD CONSTRAINT "BookingConfirmation_requestId_companyId_fkey" FOREIGN KEY ("requestId", "companyId") REFERENCES "BookingRequest"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingConfirmationInvitation" ADD CONSTRAINT "BookingConfirmationInvitation_confirmationId_companyId_fkey" FOREIGN KEY ("confirmationId", "companyId") REFERENCES "BookingConfirmation"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAttendanceEvent" ADD CONSTRAINT "BookingAttendanceEvent_confirmationId_companyId_fkey" FOREIGN KEY ("confirmationId", "companyId") REFERENCES "BookingConfirmation"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingScheduleChange" ADD CONSTRAINT "BookingScheduleChange_requestId_companyId_fkey" FOREIGN KEY ("requestId", "companyId") REFERENCES "BookingRequest"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingDepositPolicy" ADD CONSTRAINT "BookingDepositPolicy_serviceId_companyId_fkey" FOREIGN KEY ("serviceId", "companyId") REFERENCES "Service"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingDepositPolicy" ADD CONSTRAINT "BookingDepositPolicy_professionalId_companyId_fkey" FOREIGN KEY ("professionalId", "companyId") REFERENCES "ProfessionalProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingConfirmationSettings" ADD CONSTRAINT "confirmation_settings_bounds" CHECK ("leadMinutes" BETWEEN 5 AND 10080 AND "responseMinutes" BETWEEN 5 AND 10080 AND "noResponseRule" IN ('NONE','NOTIFY_STAFF','CANCEL'));
CREATE FUNCTION kalend_attendance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Attendance history is immutable'; END $$;
CREATE TRIGGER attendance_immutable BEFORE UPDATE OR DELETE ON "BookingAttendanceEvent" FOR EACH ROW EXECUTE FUNCTION kalend_attendance_immutable();
CREATE TRIGGER rescheduling_immutable BEFORE UPDATE OR DELETE ON "BookingScheduleChange" FOR EACH ROW EXECUTE FUNCTION kalend_attendance_immutable();
ALTER TABLE "BookingDepositPolicy" ADD CONSTRAINT "deposit_rule_bounds" CHECK (("percentBps" IS NULL)<>("fixedCents" IS NULL) AND ("percentBps" IS NULL OR "percentBps" BETWEEN 1 AND 10000) AND ("fixedCents" IS NULL OR "fixedCents" BETWEEN 1 AND 100000000));
CREATE UNIQUE INDEX "deposit_default_policy_unique" ON "BookingDepositPolicy"("companyId","serviceId") WHERE "professionalId" IS NULL;
