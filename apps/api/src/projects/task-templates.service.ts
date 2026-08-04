import type { CreateTaskTemplateInput, UpdateTaskTemplateInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";

const TEMPLATE_NOT_FOUND_MESSAGE = "This task template doesn't exist in this project.";

export async function listTaskTemplates(projectId: string) {
  return prisma.taskTemplate.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * IDOR barrier: every id in `labelIds` must resolve to a Label in THIS
 * project (and workspace) — mirrors tasks.service.ts#addLabel's label lookup
 * and custom-fields.service.ts#setTaskCustomFieldValue's field lookup. A
 * label id belonging to a different project (including one visible to the
 * caller in a different project they're also a member of) must never
 * silently attach.
 */
export async function assertLabelIdsInProject(
  projectId: string,
  workspaceId: string,
  labelIds: string[],
): Promise<void> {
  if (labelIds.length === 0) return;
  const found = await prisma.label.findMany({
    where: { id: { in: labelIds }, projectId, workspaceId },
    select: { id: true },
  });
  const foundIds = new Set(found.map((l) => l.id));
  const missing = labelIds.find((id) => !foundIds.has(id));
  if (missing !== undefined) {
    throw new ValidationError(`Label ${missing} doesn't exist in this project.`);
  }
}

export async function createTaskTemplate(
  workspaceId: string,
  projectId: string,
  input: CreateTaskTemplateInput,
) {
  const existing = await prisma.taskTemplate.findUnique({
    where: { projectId_name: { projectId, name: input.name } },
  });
  if (existing) {
    throw new ConflictError("A task template with this name already exists in this project.");
  }

  if (input.defaultLabelIds !== undefined) {
    await assertLabelIdsInProject(projectId, workspaceId, input.defaultLabelIds);
  }

  return prisma.taskTemplate.create({
    data: {
      workspaceId,
      projectId,
      name: input.name,
      titleTemplate: input.titleTemplate,
      description: input.description ?? null,
      priority: input.priority ?? null,
      defaultLabelIds: input.defaultLabelIds ?? [],
    },
  });
}

export async function updateTaskTemplate(
  workspaceId: string,
  projectId: string,
  templateId: string,
  input: UpdateTaskTemplateInput,
) {
  const template = await prisma.taskTemplate.findFirst({
    where: { id: templateId, projectId, workspaceId },
  });
  if (!template) {
    throw new NotFoundError(TEMPLATE_NOT_FOUND_MESSAGE);
  }

  if (input.name !== undefined && input.name !== template.name) {
    const clash = await prisma.taskTemplate.findUnique({
      where: { projectId_name: { projectId, name: input.name } },
    });
    if (clash) {
      throw new ConflictError("A task template with this name already exists in this project.");
    }
  }

  if (input.defaultLabelIds !== undefined) {
    await assertLabelIdsInProject(projectId, workspaceId, input.defaultLabelIds);
  }

  return prisma.taskTemplate.update({
    where: { id: templateId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.titleTemplate !== undefined ? { titleTemplate: input.titleTemplate } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.defaultLabelIds !== undefined ? { defaultLabelIds: input.defaultLabelIds } : {}),
    },
  });
}

/**
 * No cascade concerns: nothing references a TaskTemplate row (a task created
 * from one keeps no back-link), so deletion is always unconditionally safe.
 */
export async function deleteTaskTemplate(workspaceId: string, projectId: string, templateId: string) {
  const template = await prisma.taskTemplate.findFirst({
    where: { id: templateId, projectId, workspaceId },
  });
  if (!template) {
    throw new NotFoundError(TEMPLATE_NOT_FOUND_MESSAGE);
  }
  await prisma.taskTemplate.delete({ where: { id: templateId } });
}
