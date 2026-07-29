/**
 * ONE-TIME DATA BACKFILL for pre-existing rows created before the
 * Categories feature shipped.
 *
 * Context: this repository already has real, previously-committed Prisma
 * migration folders (see apps/api/prisma/migrations — Phase 1/2/4/5 are all
 * there), so there was no "migrations were never generated" wrinkle to work
 * around here (a full audit was done before writing this: `git log --
 * apps/api/prisma/migrations` shows every phase's migration was committed
 * along the way). What this script exists for is a narrower problem: the
 * Categories feature adds a required `categoryId` foreign key to
 * `board_columns` and `tasks`, but pre-existing rows in any already-deployed
 * database (dev data, or a real self-hosted install upgrading across this
 * release) have no category to point to yet, because the concept didn't
 * exist before now.
 *
 * This script must run AFTER migration 20260729120000_add_task_categories_nullable
 * (which adds `categoryId` as a NULLABLE column) and BEFORE migration
 * 20260729130000_task_categories_required (which makes it NOT NULL). It:
 *
 *   1. Finds every Project with zero TaskCategory rows.
 *   2. Creates exactly one bootstrap TaskCategory for it (named after the
 *      project's own name, workspace-visible by default).
 *   3. Reassigns that project's existing BoardColumn/Task rows (wherever
 *      categoryId is still null) to that bootstrap category.
 *
 * IMPORTANT — this bootstrap category is NOT the same thing as the product
 * rule that brand-new projects created after this feature ships must start
 * with ZERO categories (no auto-seeded default category name, ever — see
 * docs/PHASES.md). That rule is about the ongoing product behavior for
 * NEW projects and is completely unaffected by this script. This script
 * only ever touches PRE-EXISTING projects that already have real
 * board_columns/tasks rows with nowhere else to put them.
 *
 * Deliberately uses raw parameterized SQL (rather than the generated
 * Prisma Client's typed `boardColumn.updateMany`/`task.updateMany` calls)
 * for the null-touching reads/writes below: `schema.prisma` declares
 * `categoryId` as a required (non-nullable) field to reflect this
 * repository's steady-state schema, so the generated Client's TypeScript
 * types don't allow filtering/writing `null` for it — even though, for the
 * brief window between the two migrations above, the column is genuinely
 * still nullable at the database level. Raw SQL sidesteps that type
 * mismatch entirely while still going through the same Prisma connection.
 *
 * Safe to re-run: a project already reassigned in an earlier run already
 * has >= 1 TaskCategory row, so step 1 skips it; step 3 also only ever
 * touches rows where categoryId IS NULL, so re-running never overwrites an
 * already-assigned column/task.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface ProjectRow {
  id: string;
  workspaceId: string;
  name: string;
}

async function main() {
  const projectsNeedingBackfill = await prisma.$queryRaw<ProjectRow[]>`
    SELECT p.id, p."workspaceId", p.name
    FROM projects p
    WHERE NOT EXISTS (SELECT 1 FROM task_categories tc WHERE tc."projectId" = p.id)
  `;

  if (projectsNeedingBackfill.length === 0) {
    // eslint-disable-next-line no-console
    console.log("backfill-categories: no pre-existing projects need a bootstrap category. Nothing to do.");
  }

  for (const project of projectsNeedingBackfill) {
    await prisma.$transaction(async (tx) => {
      const bootstrapCategory = await tx.taskCategory.create({
        data: {
          workspaceId: project.workspaceId,
          projectId: project.id,
          name: project.name,
          visibility: "workspace",
        },
      });

      const columnsUpdated = await tx.$executeRaw`
        UPDATE board_columns SET "categoryId" = ${bootstrapCategory.id}
        WHERE "projectId" = ${project.id} AND "categoryId" IS NULL
      `;
      const tasksUpdated = await tx.$executeRaw`
        UPDATE tasks SET "categoryId" = ${bootstrapCategory.id}
        WHERE "projectId" = ${project.id} AND "categoryId" IS NULL
      `;

      // eslint-disable-next-line no-console
      console.log(
        `backfill-categories: project ${project.id} (${project.name}) -> bootstrap category ${bootstrapCategory.id}` +
          ` (${columnsUpdated} column(s), ${tasksUpdated} task(s) reassigned)`,
      );
    });
  }

  // Defense in depth: cover the (should-never-happen, since every project's
  // board_columns/tasks were all created together with it) case of leftover
  // categoryId-null rows for a project that already has >= 1 category
  // (e.g. this script was interrupted mid-run previously). Assign those to
  // that project's earliest-created category.
  const orphanRows = await prisma.$queryRaw<ProjectRow[]>`
    SELECT DISTINCT p.id, p."workspaceId", p.name
    FROM projects p
    WHERE EXISTS (SELECT 1 FROM board_columns bc WHERE bc."projectId" = p.id AND bc."categoryId" IS NULL)
       OR EXISTS (SELECT 1 FROM tasks t WHERE t."projectId" = p.id AND t."categoryId" IS NULL)
  `;
  for (const project of orphanRows) {
    const earliestCategory = await prisma.taskCategory.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: "asc" },
    });
    if (!earliestCategory) continue; // Should be unreachable given the pass above.
    await prisma.$executeRaw`
      UPDATE board_columns SET "categoryId" = ${earliestCategory.id}
      WHERE "projectId" = ${project.id} AND "categoryId" IS NULL
    `;
    await prisma.$executeRaw`
      UPDATE tasks SET "categoryId" = ${earliestCategory.id}
      WHERE "projectId" = ${project.id} AND "categoryId" IS NULL
    `;
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error("backfill-categories failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
