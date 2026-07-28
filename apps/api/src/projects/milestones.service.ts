import type { CreateMilestoneInput, UpdateMilestoneInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { NotFoundError } from "../core/errors.js";

const MILESTONE_NOT_FOUND_MESSAGE = "This milestone doesn't exist in this project.";

export async function listMilestones(projectId: string) {
  return prisma.milestone.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
}

export async function createMilestone(workspaceId: string, projectId: string, input: CreateMilestoneInput) {
  return prisma.milestone.create({
    data: {
      workspaceId,
      projectId,
      name: input.name,
      description: input.description ?? null,
      targetDate: input.targetDate ?? null,
    },
  });
}

export async function updateMilestone(
  workspaceId: string,
  projectId: string,
  milestoneId: string,
  input: UpdateMilestoneInput,
) {
  const milestone = await prisma.milestone.findFirst({ where: { id: milestoneId, projectId, workspaceId } });
  if (!milestone) {
    throw new NotFoundError(MILESTONE_NOT_FOUND_MESSAGE);
  }

  return prisma.milestone.update({
    where: { id: milestoneId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    },
  });
}

export async function deleteMilestone(workspaceId: string, projectId: string, milestoneId: string) {
  const milestone = await prisma.milestone.findFirst({ where: { id: milestoneId, projectId, workspaceId } });
  if (!milestone) {
    throw new NotFoundError(MILESTONE_NOT_FOUND_MESSAGE);
  }
  await prisma.milestone.delete({ where: { id: milestoneId } });
}
