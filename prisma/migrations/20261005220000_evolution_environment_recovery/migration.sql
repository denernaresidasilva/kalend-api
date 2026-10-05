-- CreateEnum
CREATE TYPE "EvolutionEnvironment" AS ENUM ('DEV', 'PRODUCTION');

-- AlterTable
ALTER TABLE "EvolutionConnection" ADD COLUMN     "codeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "codeFingerprint" TEXT,
ADD COLUMN     "connectionRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "environment" "EvolutionEnvironment",
ADD COLUMN     "lastRecoveryAt" TIMESTAMP(3);

-- Legacy rows stay unassigned until the service binds them under its distributed lease.
-- Never assume that an existing unprefixed remote instance belongs to DEV.
ALTER TABLE "EvolutionConnection" DROP CONSTRAINT "EvolutionConnection_context_check";
ALTER TABLE "EvolutionConnection" ADD CONSTRAINT "EvolutionConnection_context_check" CHECK ((
  ("companyId" IS NOT NULL AND "globalKey" IS NULL AND (
    ("environment" IS NULL AND "instanceName" = 'kalend_' || replace(lower("companyId"::text), '-', '')) OR
    ("environment" = 'DEV' AND "instanceName" = 'kalend_dev_' || replace(lower("companyId"::text), '-', '')) OR
    ("environment" = 'PRODUCTION' AND "instanceName" = 'kalend_' || replace(lower("companyId"::text), '-', ''))
  )) OR
  ("companyId" IS NULL AND "globalKey" = 'GLOBAL' AND (
    ("environment" IS NULL AND "instanceName" ~ '^[A-Za-z0-9_-]{1,100}$' AND "instanceName" !~* '^kalend_[a-f0-9]{32}$') OR
    ("environment" = 'DEV' AND "instanceName" = 'kalend_dev_global') OR
    ("environment" = 'PRODUCTION' AND "instanceName" ~ '^[A-Za-z0-9_-]{1,100}$' AND "instanceName" !~* '^kalend_dev_' AND "instanceName" !~* '^kalend_[a-f0-9]{32}$')
  ))
) IS TRUE);
