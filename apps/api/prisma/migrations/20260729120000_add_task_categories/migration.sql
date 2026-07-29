-- Categories feature: adds TaskCategory/CategoryMembership and the new
-- required `categoryId` FK on board_columns/tasks (plus an optional
-- `categoryId` on activity_events, since project-level events like
-- `milestone_completed` never have a category in scope). This is
-- deliberately a single migration, not a nullable-then-required two-step
-- sequence: this is pre-production software with no real deployed data to
-- preserve, so there is no backfill concern to design around. See
-- docs/PHASES.md / docs/ARCHITECTURE.md for the product rationale behind
-- the Categories tier itself.

-- CreateEnum
CREATE TYPE "CategoryVisibility" AS ENUM ('workspace', 'private');

-- CreateTable
CREATE TABLE "task_categories" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" "CategoryVisibility" NOT NULL DEFAULT 'workspace',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_memberships" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_categories_workspaceId_idx" ON "task_categories"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "task_categories_projectId_name_key" ON "task_categories"("projectId", "name");

-- CreateIndex
CREATE INDEX "category_memberships_workspaceId_idx" ON "category_memberships"("workspaceId");

-- CreateIndex
CREATE INDEX "category_memberships_userId_idx" ON "category_memberships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "category_memberships_categoryId_userId_key" ON "category_memberships"("categoryId", "userId");

-- AlterTable: categoryId is required from the start on board_columns/tasks.
ALTER TABLE "board_columns" ADD COLUMN "categoryId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "categoryId" TEXT NOT NULL;

-- AlterTable: activity_events.categoryId is nullable by design (not a
-- migration-safety artifact) — project-level events with no category in
-- scope (e.g. milestone_completed) leave it null; see schema.prisma.
ALTER TABLE "activity_events" ADD COLUMN "categoryId" TEXT;

-- Column names are unique within a category's own board (not project-wide)
-- from the start — replaces the Phase 2 project-wide uniqueness.
DROP INDEX "board_columns_projectId_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "board_columns_categoryId_name_key" ON "board_columns"("categoryId", "name");

-- CreateIndex
CREATE INDEX "board_columns_categoryId_position_idx" ON "board_columns"("categoryId", "position");

-- CreateIndex
CREATE INDEX "tasks_categoryId_columnId_position_idx" ON "tasks"("categoryId", "columnId", "position");

-- CreateIndex
CREATE INDEX "activity_events_categoryId_idx" ON "activity_events"("categoryId");

-- AddForeignKey
ALTER TABLE "task_categories" ADD CONSTRAINT "task_categories_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_categories" ADD CONSTRAINT "task_categories_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_memberships" ADD CONSTRAINT "category_memberships_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_memberships" ADD CONSTRAINT "category_memberships_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "task_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_memberships" ADD CONSTRAINT "category_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "task_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "task_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "task_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
