import type { CreateLabelInput, UpdateLabelInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ConflictError, NotFoundError } from "../core/errors.js";

const LABEL_NOT_FOUND_MESSAGE = "This label doesn't exist in this project.";

export async function listLabels(projectId: string) {
  return prisma.label.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
}

export async function createLabel(workspaceId: string, projectId: string, input: CreateLabelInput) {
  const existing = await prisma.label.findUnique({ where: { projectId_name: { projectId, name: input.name } } });
  if (existing) {
    throw new ConflictError("A label with this name already exists in this project.");
  }
  return prisma.label.create({
    data: { workspaceId, projectId, name: input.name, color: input.color },
  });
}

export async function updateLabel(
  workspaceId: string,
  projectId: string,
  labelId: string,
  input: UpdateLabelInput,
) {
  const label = await prisma.label.findFirst({ where: { id: labelId, projectId, workspaceId } });
  if (!label) {
    throw new NotFoundError(LABEL_NOT_FOUND_MESSAGE);
  }

  if (input.name !== undefined && input.name !== label.name) {
    const clash = await prisma.label.findUnique({ where: { projectId_name: { projectId, name: input.name } } });
    if (clash) {
      throw new ConflictError("A label with this name already exists in this project.");
    }
  }

  return prisma.label.update({
    where: { id: labelId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    },
  });
}

export async function deleteLabel(workspaceId: string, projectId: string, labelId: string) {
  const label = await prisma.label.findFirst({ where: { id: labelId, projectId, workspaceId } });
  if (!label) {
    throw new NotFoundError(LABEL_NOT_FOUND_MESSAGE);
  }
  await prisma.label.delete({ where: { id: labelId } });
}
