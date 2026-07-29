-- Categories feature, step 1 of 2 (see docs/PHASES.md for the full
-- rationale): adds the new TaskCategory/CategoryMembership tables and the
-- new `categoryId` columns on board_columns/tasks/activity_events as
-- NULLABLE first. A one-time backfill script
-- (prisma/backfill-categories.ts) is run against every existing environment
-- between this migration and the next one, assigning a bootstrap category
-- to every pre-existing project and reassigning its existing columns/tasks
-- to it. Only once that backfill has completed does the follow-up migration
-- (20260729130000_task_categories_required) make `categoryId` NOT NULL on
-- board_columns/tasks and swap board_columns' unique constraint from
-- (projectId, name) to (categoryId, name).
--
-- This two-step split is required because this repository's project/board
-- column/task rows already exist in deployed databases (dev data, and
-- potentially real self-hosted installs) with no category assigned yet —
-- adding a NOT NULL FK column in one shot would either fail outright or
-- require an unsafe default. Brand new environments (e.g. a fresh test
-- database) have zero existing rows, so the backfill is a no-op for them,
-- but the same two-migration shape is used everywhere for consistency and
-- to keep this migration history simple to reason about.

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

-- AlterTable (nullable for now — see header comment)
ALTER TABLE "activity_events" ADD COLUMN "categoryId" TEXT;

-- AlterTable (nullable for now — see header comment)
ALTER TABLE "board_columns" ADD COLUMN "categoryId" TEXT;

-- AlterTable (nullable for now — see header comment)
ALTER TABLE "tasks" ADD COLUMN "categoryId" TEXT;

-- CreateIndex
CREATE INDEX "activity_events_categoryId_idx" ON "activity_events"("categoryId");

-- CreateIndex
CREATE INDEX "board_columns_categoryId_position_idx" ON "board_columns"("categoryId", "position");

-- CreateIndex
CREATE INDEX "tasks_categoryId_columnId_position_idx" ON "tasks"("categoryId", "columnId", "position");

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
