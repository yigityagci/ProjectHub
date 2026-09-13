-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE 'task_completed';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "completedById" TEXT;

-- CreateIndex
CREATE INDEX "tasks_completedById_idx" ON "tasks"("completedById");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
