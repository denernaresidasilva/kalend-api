-- AlterEnum
ALTER TYPE "CommunicationScope" ADD VALUE 'COMPANY';

-- AlterTable
ALTER TABLE "GlobalCommunicationDelivery" ADD COLUMN     "templateScope" "CommunicationScope" NOT NULL DEFAULT 'GLOBAL';

-- CreateTable
CREATE TABLE "CompanyCommunicationTemplate" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "content" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyCommunicationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyCommunicationTemplate_event_channel_idx" ON "CompanyCommunicationTemplate"("event", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyCommunicationTemplate_companyId_event_channel_key" ON "CompanyCommunicationTemplate"("companyId", "event", "channel");

-- AddForeignKey
ALTER TABLE "CompanyCommunicationTemplate" ADD CONSTRAINT "CompanyCommunicationTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
