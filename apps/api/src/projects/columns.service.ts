import type { CreateColumnInput, UpdateColumnInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ConflictError, NotFoundError } from "../core/errors.js";
import { computeAppendPosition } from "./position.js";
import { DONE_CATEGORY } from "./tasks.service.js";

const DONE_COLUMN_EXISTS_MESSAGE =
  "This board already has a Done column. Each board can only have one — rename or repurpose the existing one instead.";

const COLUMN_NOT_FOUND_MESSAGE = "This column doesn't exist in this category.";

export async function listColumns(categoryId: string) {
  return prisma.boardColumn.findMany({
    where: { categoryId },
    orderBy: { position: "asc" },
  });
}

export async function getColumnOrThrow(workspaceId: string, categoryId: string, columnId: string) {
  const column = await prisma.boardColumn.findFirst({
    where: { id: columnId, categoryId, workspaceId },
  });
  if (!column) {
    throw new NotFoundError(COLUMN_NOT_FOUND_MESSAGE);
  }
  return column;
}

export async function createColumn(
  workspaceId: string,
  projectId: string,
  categoryId: string,
  input: CreateColumnInput,
) {
  const existingName = await prisma.boardColumn.findUnique({
    where: { categoryId_name: { categoryId, name: input.name } },
  });
  if (existingName) {
    throw new ConflictError("A column with this name already exists on this board.");
  }

  if (input.category === DONE_CATEGORY) {
    const existingDone = await prisma.boardColumn.findFirst({ where: { categoryId, category: DONE_CATEGORY } });
    if (existingDone) {
      throw new ConflictError(DONE_COLUMN_EXISTS_MESSAGE);
    }
  }

  const maxPositionColumn = await prisma.boardColumn.findFirst({
    where: { categoryId },
    orderBy: { position: "desc" },
  });

  return prisma.boardColumn.create({
    data: {
      workspaceId,
      projectId,
      categoryId,
      name: input.name,
      category: input.category,
      color: input.color ?? null,
      position: computeAppendPosition(maxPositionColumn?.position ?? null),
    },
  });
}

export async function updateColumn(
  workspaceId: string,
  categoryId: string,
  columnId: string,
  input: UpdateColumnInput,
) {
  await getColumnOrThrow(workspaceId, categoryId, columnId);

  if (input.name !== undefined) {
    const existingName = await prisma.boardColumn.findUnique({
      where: { categoryId_name: { categoryId, name: input.name } },
    });
    if (existingName && existingName.id !== columnId) {
      throw new ConflictError("A column with this name already exists on this board.");
    }
  }

  if (input.category === DONE_CATEGORY) {
    const existingDone = await prisma.boardColumn.findFirst({ where: { categoryId, category: DONE_CATEGORY } });
    if (existingDone && existingDone.id !== columnId) {
      throw new ConflictError(DONE_COLUMN_EXISTS_MESSAGE);
    }
  }

  return prisma.boardColumn.update({
    where: { id: columnId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      // color is nullable-on-update: an explicit `null` clears a custom
      // color back to the category default, `undefined` (key omitted)
      // leaves whatever color was already set untouched.
      ...(input.color !== undefined ? { color: input.color } : {}),
    },
  });
}

export async function reorderColumns(workspaceId: string, categoryId: string, columnIds: string[]) {
  const columns = await prisma.boardColumn.findMany({ where: { categoryId, workspaceId } });
  const columnIdSet = new Set(columns.map((c) => c.id));

  if (columnIds.length !== columns.length || !columnIds.every((id) => columnIdSet.has(id))) {
    throw new NotFoundError(
      "The column list must include every column of this category exactly once.",
    );
  }

  await prisma.$transaction(
    columnIds.map((id, index) =>
      prisma.boardColumn.update({ where: { id }, data: { position: index + 1 } }),
    ),
  );

  return listColumns(categoryId);
}

export async function deleteColumn(workspaceId: string, categoryId: string, columnId: string) {
  await getColumnOrThrow(workspaceId, categoryId, columnId);

  const taskCount = await prisma.task.count({ where: { columnId } });
  if (taskCount > 0) {
    throw new ConflictError(
      "This column still has tasks in it. Move or delete its tasks before deleting the column.",
    );
  }

  try {
    await prisma.boardColumn.delete({ where: { id: columnId } });
  } catch (_err) {
    // Defense in depth against a race where a task was inserted into this
    // column between the count check above and the delete (the FK is
    // onDelete: Restrict), surfaced as a clean 409 instead of a raw DB error.
    throw new ConflictError(
      "This column still has tasks in it. Move or delete its tasks before deleting the column.",
    );
  }
}
