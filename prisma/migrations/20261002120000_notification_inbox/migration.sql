ALTER TABLE "GlobalCommunicationOutbox" ADD COLUMN "notificationProcessedAt" TIMESTAMP(3);
CREATE INDEX "GlobalCommunicationOutbox_notificationProcessedAt_createdAt_idx" ON "GlobalCommunicationOutbox" ("notificationProcessedAt", "createdAt");
CREATE TABLE "Notification" (
 "id" UUID NOT NULL, "userId" UUID NOT NULL, "companyId" UUID,
 "sourceKey" TEXT NOT NULL, "type" TEXT NOT NULL, "title" TEXT NOT NULL,
 "message" TEXT NOT NULL, "actionUrl" TEXT, "actionLabel" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
 "expiresAt" TIMESTAMP(3) GENERATED ALWAYS AS ("createdAt" + INTERVAL '168 hours') STORED NOT NULL,
 "readAt" TIMESTAMP(3),
 CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "Notification_retention_check" CHECK ("expiresAt" = "createdAt" + INTERVAL '168 hours'),
 CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "Notification_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Notification_userId_sourceKey_key" ON "Notification" ("userId", "sourceKey");
CREATE INDEX "Notification_userId_companyId_readAt_createdAt_id_idx" ON "Notification" ("userId", "companyId", "readAt", "createdAt", "id");
CREATE INDEX "Notification_expiresAt_idx" ON "Notification" ("expiresAt");
CREATE TABLE "NotificationPreference" (
 "userId" UUID NOT NULL, "inSystemEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId"),
 CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Old journal entries have no retained inbox history. Do not let them delay new events.
UPDATE "GlobalCommunicationOutbox" SET "notificationProcessedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
WHERE "createdAt" <= LOCALTIMESTAMP - INTERVAL '168 hours';
