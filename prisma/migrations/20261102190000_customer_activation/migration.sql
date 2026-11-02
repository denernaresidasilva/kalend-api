BEGIN;
ALTER TABLE "CustomerProfile" ADD COLUMN "userId" UUID;
ALTER TABLE "CustomerProfile" ADD CONSTRAINT "CustomerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "CustomerProfile_companyId_userId_key" ON "CustomerProfile"("companyId", "userId");
CREATE TABLE "CustomerActivation" (
 "id" UUID NOT NULL PRIMARY KEY,
 "companyId" UUID NOT NULL,
 "customerId" UUID NOT NULL,
 "tokenHash" TEXT NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "usedAt" TIMESTAMP(3),
 "createdById" UUID NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CustomerActivation_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "CustomerProfile"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CustomerActivation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "CustomerActivation_token_hash_format" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "CustomerActivation_tokenHash_key" ON "CustomerActivation"("tokenHash");
CREATE UNIQUE INDEX "CustomerActivation_customerId_companyId_key" ON "CustomerActivation"("customerId", "companyId");
CREATE INDEX "CustomerActivation_expiresAt_idx" ON "CustomerActivation"("expiresAt");
COMMIT;
