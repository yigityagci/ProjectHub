-- Categories feature, step 2 of 2. Must only be applied AFTER
-- prisma/backfill-categories.ts has been run against this database (it is
-- re-runnable/idempotent, so running it again here is always safe) — that
-- script guarantees every board_columns/tasks row has a non-null
-- categoryId by creating a bootstrap TaskCategory for any pre-existing
-- project that has zero categories and reassigning its columns/tasks to it.
-- Once that invariant holds, this migration finishes the job: makes
-- `categoryId` required, and swaps board_columns' uniqueness scope from
-- project-wide to per-category (a project can now have multiple
-- categories, each with its own independently-named "To Do"/"In
-- Progress"/"Done" columns).

-- AlterTable
ALTER TABLE "board_columns" ALTER COLUMN "categoryId" SET NOT NULL;

-- AlterTable
ALTER TABLE "tasks" ALTER COLUMN "categoryId" SET NOT NULL;

-- DropIndex
DROP INDEX "board_columns_projectId_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "board_columns_categoryId_name_key" ON "board_columns"("categoryId", "name");
