-- CreateTable
CREATE TABLE "AiAssistantSettings" (
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL DEFAULT 'Assistente',
    "welcome" TEXT NOT NULL DEFAULT 'Olá! Posso ajudar a consultar serviços e horários. Peça atendimento humano quando preferir.',
    "tone" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "businessInfo" TEXT NOT NULL DEFAULT '',
    "schedule" JSONB NOT NULL DEFAULT '[]',
    "humanHandoff" BOOLEAN NOT NULL DEFAULT true,
    "maxMessagesPerDay" INTEGER NOT NULL DEFAULT 50,
    "maxInputTokens" INTEGER NOT NULL DEFAULT 2000,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 300,
    "maxEstimatedCostCents" INTEGER NOT NULL DEFAULT 1000,
    "historyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "retentionDays" INTEGER NOT NULL DEFAULT 7,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAssistantSettings_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "AiToolAudit" (
    "requestKey" TEXT,
    "requestHash" TEXT,
    "decision" JSONB,
    "reservedCents" INTEGER NOT NULL DEFAULT 0,
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiToolAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiToolAudit_companyId_createdAt_idx" ON "AiToolAudit"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiToolAudit_companyId_requestKey_key" ON "AiToolAudit"("companyId", "requestKey");

-- AddForeignKey
ALTER TABLE "AiAssistantSettings" ADD CONSTRAINT "AiAssistantSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiToolAudit" ADD CONSTRAINT "AiToolAudit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AiAssistantSettings" ADD CONSTRAINT "ai_settings_bounds" CHECK ("maxMessagesPerDay" BETWEEN 1 AND 10000 AND "maxInputTokens" BETWEEN 100 AND 8000 AND "maxOutputTokens" BETWEEN 50 AND 1000 AND "maxEstimatedCostCents" BETWEEN 1 AND 1000000 AND "retentionDays" BETWEEN 1 AND 90);
ALTER TABLE "AiToolAudit" ADD CONSTRAINT "ai_usage_nonnegative" CHECK ("reservedCents">=0 AND "inputTokens">=0 AND "outputTokens">=0 AND ("estimatedCostCents" IS NULL OR "estimatedCostCents">=0));
