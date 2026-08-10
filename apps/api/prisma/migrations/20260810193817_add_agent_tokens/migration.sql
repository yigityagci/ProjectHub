-- AlterTable
ALTER TABLE "activity_events" ADD COLUMN     "viaAgentTokenId" TEXT;

-- CreateTable
CREATE TABLE "agent_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_tokens_tokenHash_key" ON "agent_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "agent_tokens_userId_idx" ON "agent_tokens"("userId");

-- CreateIndex
CREATE INDEX "activity_events_viaAgentTokenId_idx" ON "activity_events"("viaAgentTokenId");

-- AddForeignKey
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_viaAgentTokenId_fkey" FOREIGN KEY ("viaAgentTokenId") REFERENCES "agent_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
