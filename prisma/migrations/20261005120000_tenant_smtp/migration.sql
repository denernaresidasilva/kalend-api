ALTER TABLE "GlobalCommunicationProvider" ADD COLUMN "lastTestRecipient" TEXT, ADD COLUMN "lastTestStatus" TEXT;
CREATE TABLE "CompanyEmailConfiguration" (
  "companyId" UUID NOT NULL,
  "config" JSONB NOT NULL,
  "credentialsEncrypted" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "lastVerifiedAt" TIMESTAMP(3),
  "lastTestRecipient" TEXT,
  "lastTestStatus" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanyEmailConfiguration_pkey" PRIMARY KEY ("companyId"),
  CONSTRAINT "CompanyEmailConfiguration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
