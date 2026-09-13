-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "completedFromColumnId" TEXT;

-- CreateIndex
CREATE INDEX "tasks_completedFromColumnId_idx" ON "tasks"("completedFromColumnId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completedFromColumnId_fkey" FOREIGN KEY ("completedFromColumnId") REFERENCES "board_columns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
