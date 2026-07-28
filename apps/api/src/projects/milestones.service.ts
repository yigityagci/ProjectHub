import type { CreateMilestoneInput, UpdateMilestoneInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { NotFoundError } from "../core/errors.js";
import { createActivityEvent, broadcastActivityEvent } from "../activity/activity.service.js";

const MILESTONE_NOT_FOUND_MESSAGE = "This milestone doesn't exist in this project.";

export interface MilestoneUpdateActor {
  id: string;
  displayName: string;
}

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
  actor: MilestoneUpdateActor,
) {
  const milestone = await prisma.milestone.findFirst({ where: { id: milestoneId, projectId, workspaceId } });
  if (!milestone) {
    throw new NotFoundError(MILESTONE_NOT_FOUND_MESSAGE);
  }

  // An activity event is only recorded on the incomplete -> complete
  // transition (not on every edit, and not when completedAt is cleared).
  const isBeingCompleted = milestone.completedAt === null && input.completedAt != null;

  const { updated, activityEvent } = await prisma.$transaction(async (tx) => {
    const updatedMilestone = await tx.milestone.update({
      where: { id: milestoneId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
      },
    });

    const event = isBeingCompleted
      ? await createActivityEvent(tx, {
          workspaceId,
          projectId,
          actorId: actor.id,
          type: "milestone_completed",
          payload: {
            milestoneId,
            milestoneName: updatedMilestone.name,
            actorDisplayName: actor.displayName,
          },
        })
      : null;

    return { updated: updatedMilestone, activityEvent: event };
  });

  if (activityEvent) {
    broadcastActivityEvent(activityEvent);
  }

  return updated;
}

export async function deleteMilestone(workspaceId: string, projectId: string, milestoneId: string) {
  const milestone = await prisma.milestone.findFirst({ where: { id: milestoneId, projectId, workspaceId } });
  if (!milestone) {
    throw new NotFoundError(MILESTONE_NOT_FOUND_MESSAGE);
  }
  await prisma.milestone.delete({ where: { id: milestoneId } });
}
