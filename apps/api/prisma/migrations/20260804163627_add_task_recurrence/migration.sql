-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "nextRunAt" TIMESTAMP(3),
ADD COLUMN     "recurrenceCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recurrenceRule" JSONB,
ADD COLUMN     "recurrenceTemplateId" TEXT;

-- CreateIndex
CREATE INDEX "tasks_nextRunAt_idx" ON "tasks"("nextRunAt");

-- CreateIndex
CREATE INDEX "tasks_recurrenceTemplateId_idx" ON "tasks"("recurrenceTemplateId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_recurrenceTemplateId_fkey" FOREIGN KEY ("recurrenceTemplateId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
