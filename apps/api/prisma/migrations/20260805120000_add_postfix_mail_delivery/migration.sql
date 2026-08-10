-- CreateTable
CREATE TABLE "platform_postfix_configs" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sendingDomain" TEXT NOT NULL,
    "mailHostname" TEXT NOT NULL,
    "senderName" TEXT NOT NULL DEFAULT 'ProjectHub',
    "replyToAddress" TEXT,
    "dkimSelector" TEXT NOT NULL DEFAULT 'projecthub',
    "dkimKeyBits" INTEGER NOT NULL DEFAULT 2048,
    "dkimPrivateKeyCiphertext" TEXT,
    "dkimPublicKey" TEXT,
    "dkimGeneratedAt" TIMESTAMP(3),
    "dkimSigningEnabled" BOOLEAN NOT NULL DEFAULT false,
    "destinationRateDelaySeconds" INTEGER NOT NULL DEFAULT 0,
    "destinationConcurrencyLimit" INTEGER NOT NULL DEFAULT 20,
    "messageSizeLimitBytes" INTEGER NOT NULL DEFAULT 10485760,
    "lastAppliedAt" TIMESTAMP(3),
    "lastApplyOk" BOOLEAN,
    "lastApplyError" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_postfix_configs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "platform_postfix_configs" ADD CONSTRAINT "platform_postfix_configs_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: Prisma does not model CHECK constraints, so this is added
-- manually and will not be reproduced by a future `migrate diff`. Enforces
-- the single-row invariant in the database, not just in application code —
-- mirrors platform_email_configs_singleton_check.
ALTER TABLE "platform_postfix_configs"
  ADD CONSTRAINT "platform_postfix_configs_singleton_check" CHECK ("id" = 'singleton');
