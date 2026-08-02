-- CreateEnum
CREATE TYPE "SmtpSecurity" AS ENUM ('none', 'starttls', 'tls');

-- CreateTable
CREATE TABLE "platform_email_configs" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "security" "SmtpSecurity" NOT NULL DEFAULT 'starttls',
    "username" TEXT,
    "passwordCiphertext" TEXT,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_email_configs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "platform_email_configs" ADD CONSTRAINT "platform_email_configs_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: Prisma does not model CHECK constraints, so this is added
-- manually and will not be reproduced by a future `migrate diff`. Enforces
-- the single-row invariant in the database, not just in application code.
ALTER TABLE "platform_email_configs"
  ADD CONSTRAINT "platform_email_configs_singleton_check" CHECK ("id" = 'singleton');
