-- CreateEnum
CREATE TYPE "EvolutionConnectionStatus" AS ENUM ('PENDING', 'CREATING', 'QR_AVAILABLE', 'CONNECTING', 'CONNECTED', 'DISCONNECTED', 'ERROR');

-- CreateTable
CREATE TABLE "EvolutionConnection" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "instanceName" TEXT NOT NULL,
    "status" "EvolutionConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "prepared" BOOLEAN NOT NULL DEFAULT false,
    "pairingMethod" TEXT NOT NULL DEFAULT 'QR',
    "phone" TEXT,
    "profileName" TEXT,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastQrAt" TIMESTAMP(3),
    "lastError" TEXT,
    "webhookSecretEncrypted" TEXT,
    "lastWebhookAt" TIMESTAMP(3),
    "leaseId" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvolutionConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EvolutionConnection_companyId_key" ON "EvolutionConnection"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "EvolutionConnection_instanceName_key" ON "EvolutionConnection"("instanceName");

-- AddForeignKey
ALTER TABLE "EvolutionConnection" ADD CONSTRAINT "EvolutionConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
