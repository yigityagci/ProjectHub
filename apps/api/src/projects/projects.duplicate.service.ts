import type { ColumnCategory, CustomFieldType, RoleKey } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { NotFoundError } from "../core/errors.js";
import { listCategoriesForUser, createCategory } from "./categories.service.js";
import { listColumns, createColumn, updateColumn, deleteColumn, reorderColumns } from "./columns.service.js";
import { listLabels, createLabel } from "./labels.service.js";
import { listCustomFields, createCustomField, toOptionsArray } from "./custom-fields.service.js";
import { deleteProject } from "./projects.service.js";

export interface DuplicateProjectParams {
  workspaceId: string;
  sourceProjectId: string;
  actorId: string;
  actorRoleKey: RoleKey;
  name: string;
}

export interface DuplicateProjectResult {
  project: {
    id: string;
    workspaceId: string;
    name: string;
    description: string | null;
    ownerId: string;
    status: string;
    visibility: string;
    startDate: Date | null;
    targetDate: Date | null;
    archived: boolean;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  copied: { categories: number; columns: number; labels: number; customFields: number };
}

/**
 * Runs the column-reconciliation algorithm for one newly-created category:
 * resolves the collision between the 3 auto-seeded DEFAULT_COLUMNS
 * (createCategory always seeds them) and the source category's actual
 * columns, then reorders to match the source's exact order. Always safe to
 * delete leftover seeded columns and to reorder freely: this category was
 * created milliseconds ago in THIS flow and has zero tasks.
 */
async function reconcileColumns(
  workspaceId: string,
  newProjectId: string,
  newCategoryId: string,
  sourceColumns: Array<{ name: string; category: ColumnCategory; color: string | null }>,
): Promise<number> {
  const seeded = await listColumns(newCategoryId);
  const seededByName = new Map(seeded.map((c) => [c.name, c]));
  const unmatchedSeededIds = new Set(seeded.map((c) => c.id));
  const orderedNewIds: string[] = [];

  for (const src of sourceColumns) {
    const hit = seededByName.get(src.name);
    if (hit) {
      if (hit.category !== src.category || hit.color !== src.color) {
        await updateColumn(workspaceId, newCategoryId, hit.id, {
          category: src.category,
          color: src.color,
        });
      }
      unmatchedSeededIds.delete(hit.id);
      orderedNewIds.push(hit.id);
    } else {
      const created = await createColumn(workspaceId, newProjectId, newCategoryId, {
        name: src.name,
        category: src.category,
        color: src.color ?? null,
      });
      orderedNewIds.push(created.id);
    }
  }

  for (const id of unmatchedSeededIds) {
    await deleteColumn(workspaceId, newCategoryId, id);
  }

  await reorderColumns(workspaceId, newCategoryId, orderedNewIds);

  return orderedNewIds.length;
}

/**
 * Stateless one-shot structural copy of a project (categories, boards,
 * columns, labels, custom fields) into a brand-new project in the same
 * workspace. Deliberately NEVER creates a Task row, and NEVER copies
 * ProjectMembership/CategoryMembership (private categories' specific member
 * lists do not carry over — avoids silently granting access).
 *
 * Not wrapped in one single DB transaction: createCategory already opens and
 * commits its OWN transaction internally per category, so nesting further
 * transactional writes across many categories/labels/custom-fields on top of
 * that isn't achievable without refactoring those already-tested existing
 * service functions. Instead, on ANY failure partway through, the
 * partially-built new project is deleted via the existing deleteProject as a
 * compensating action. This is always safe here specifically because this
 * flow never creates a Task row, so deleteProject's own "delete all tasks
 * first" transactional step is always a no-op for a project built by this
 * flow.
 */
export async function duplicateProject(params: DuplicateProjectParams): Promise<DuplicateProjectResult> {
  const { workspaceId, sourceProjectId, actorId, actorRoleKey, name } = params;

  const source = await prisma.project.findFirst({
    where: { id: sourceProjectId, workspaceId },
  });
  if (!source) {
    throw new NotFoundError("This project doesn't exist or you don't have access to it.");
  }

  // Gather source structure BEFORE writing anything.
  const sourceCategories = await listCategoriesForUser(sourceProjectId, actorId, actorRoleKey);
  const sourceCategoryColumns = await Promise.all(
    sourceCategories.map((cat) => listColumns(cat.id)),
  );
  const sourceLabels = await listLabels(sourceProjectId);
  const sourceCustomFields = await listCustomFields(sourceProjectId);

  const newProject = await prisma.project.create({
    data: {
      workspaceId,
      name,
      description: source.description,
      ownerId: actorId,
      status: "planning",
      visibility: source.visibility,
      startDate: null,
      targetDate: null,
      archived: false,
    },
  });

  try {
    let columnCount = 0;

    for (let i = 0; i < sourceCategories.length; i += 1) {
      const cat = sourceCategories[i]!;
      const newCategory = await createCategory({
        workspaceId,
        projectId: newProject.id,
        name: cat.name,
        visibility: cat.visibility,
      });

      const sourceColumns = sourceCategoryColumns[i]!.map((c) => ({
        name: c.name,
        category: c.category as ColumnCategory,
        color: c.color,
      }));

      columnCount += await reconcileColumns(workspaceId, newProject.id, newCategory.id, sourceColumns);
    }

    for (const l of sourceLabels) {
      await createLabel(workspaceId, newProject.id, { name: l.name, color: l.color });
    }

    for (const f of sourceCustomFields) {
      await createCustomField(workspaceId, newProject.id, {
        name: f.name,
        type: f.type as CustomFieldType,
        options: toOptionsArray(f.options),
      });
    }

    return {
      project: newProject,
      copied: {
        categories: sourceCategories.length,
        columns: columnCount,
        labels: sourceLabels.length,
        customFields: sourceCustomFields.length,
      },
    };
  } catch (err) {
    await deleteProject(newProject.id).catch(() => undefined);
    throw err;
  }
}
