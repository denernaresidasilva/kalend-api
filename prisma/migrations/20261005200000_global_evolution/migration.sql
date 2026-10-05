-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EvolutionConnectionStatus" ADD VALUE 'CREATED';
ALTER TYPE "EvolutionConnectionStatus" ADD VALUE 'DELETING';

-- AlterTable
ALTER TABLE "EvolutionConnection" ADD COLUMN     "globalKey" TEXT,
ALTER COLUMN "companyId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "EvolutionConnection_globalKey_key" ON "EvolutionConnection"("globalKey");

-- Exactly one context per connection; the unique GLOBAL key enforces a singleton.
ALTER TABLE "EvolutionConnection" ADD CONSTRAINT "EvolutionConnection_context_check" CHECK ((
  ("companyId" IS NOT NULL AND "globalKey" IS NULL AND "instanceName" = 'kalend_' || replace(lower("companyId"::text), '-', '')) OR
  ("companyId" IS NULL AND "globalKey" = 'GLOBAL' AND "instanceName" ~ '^[A-Za-z0-9_-]{1,100}$' AND "instanceName" !~* '^kalend_[a-f0-9]{32}$')
) IS TRUE);
