-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'due_date_soon';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "dueReminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notifyOnDueDate" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "tasks_dueReminderSentAt_dueDate_idx" ON "tasks"("dueReminderSentAt", "dueDate");
