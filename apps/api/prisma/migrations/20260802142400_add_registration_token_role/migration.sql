-- Registration tokens now carry a role: the generator picks the role the
-- redeeming user will join the workspace with. No existing rows carried a
-- role (table was empty at the time this feature was extended), so this is
-- a plain required-column add with no backfill needed.
ALTER TABLE "registration_tokens" ADD COLUMN "roleId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "registration_tokens_roleId_idx" ON "registration_tokens"("roleId");

-- AddForeignKey
ALTER TABLE "registration_tokens" ADD CONSTRAINT "registration_tokens_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
