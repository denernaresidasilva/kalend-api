CREATE TABLE "PublicSignupConsent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "termsVersion" TEXT NOT NULL,
  "privacyVersion" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
  "marketingConsentedAt" TIMESTAMP(3),
  "attribution" JSONB,
  "source" TEXT NOT NULL DEFAULT 'PUBLIC_LP',
  CONSTRAINT "PublicSignupConsent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublicSignupConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PublicSignupConsent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PublicSignupConsent_userId_companyId_key" ON "PublicSignupConsent"("userId", "companyId");
CREATE INDEX "PublicSignupConsent_companyId_acceptedAt_idx" ON "PublicSignupConsent"("companyId", "acceptedAt");
