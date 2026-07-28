import type { CreateCommentInput } from "@projecthub/shared";
import { MENTION_TOKEN_PATTERN } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { NotFoundError, ForbiddenError } from "../core/errors.js";
import { isElevatedRole } from "../rbac/authorize.js";
import type { RoleKey } from "@projecthub/shared";
import { emitToProject } from "../realtime/realtime.js";
import { createNotification } from "../notifications/notifications.service.js";

const COMMENT_NOT_FOUND_MESSAGE = "This comment doesn't exist on this task.";

function serializeComment(comment: {
  id: string;
  taskId: string;
  authorId: string;
  author: { id: string; displayName: string; email: string };
  body: string;
  createdAt: Date;
  updatedAt: Date;
  mentions: { mentionedUserId: string }[];
}) {
  return {
    id: comment.id,
    taskId: comment.taskId,
    authorId: comment.authorId,
    authorDisplayName: comment.author.displayName,
    authorEmail: comment.author.email,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    mentionedUserIds: comment.mentions.map((m) => m.mentionedUserId),
  };
}

export async function listComments(workspaceId: string, projectId: string, taskId: string) {
  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId, projectId } });
  if (!task) {
    throw new NotFoundError("This task doesn't exist in this project.");
  }
  const comments = await prisma.comment.findMany({
    where: { taskId, workspaceId },
    include: { author: true, mentions: true },
    orderBy: { createdAt: "asc" },
  });
  return comments.map(serializeComment);
}

/**
 * Extracts `@[userId]` tokens from a comment body (see the mention parsing
 * convention documented in packages/shared/src/dto/comment.ts and in
 * prisma/schema.prisma), de-duplicated and filtered to active workspace
 * members other than the comment's own author.
 */
async function resolveMentionedUserIds(
  workspaceId: string,
  authorId: string,
  body: string,
): Promise<string[]> {
  const candidateIds = new Set<string>();
  for (const match of body.matchAll(MENTION_TOKEN_PATTERN)) {
    const candidate = match[1];
    if (candidate && candidate !== authorId) candidateIds.add(candidate);
  }
  if (candidateIds.size === 0) return [];

  const activeMembers = await prisma.workspaceMembership.findMany({
    where: { workspaceId, userId: { in: [...candidateIds] }, status: "active" },
    select: { userId: true },
  });
  return activeMembers.map((m) => m.userId);
}

export interface CreateCommentParams {
  workspaceId: string;
  projectId: string;
  taskId: string;
  authorId: string;
  input: CreateCommentInput;
}

export async function createComment(params: CreateCommentParams) {
  const { workspaceId, projectId, taskId, authorId, input } = params;
  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId, projectId } });
  if (!task) {
    throw new NotFoundError("This task doesn't exist in this project.");
  }

  const mentionedUserIds = await resolveMentionedUserIds(workspaceId, authorId, input.body);

  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: { workspaceId, taskId, authorId, body: input.body },
      include: { author: true, mentions: true },
    });
    if (mentionedUserIds.length > 0) {
      await tx.mention.createMany({
        data: mentionedUserIds.map((mentionedUserId) => ({
          workspaceId,
          commentId: created.id,
          mentionedUserId,
        })),
      });
    }
    return created;
  });

  const withMentions = await prisma.comment.findUniqueOrThrow({
    where: { id: comment.id },
    include: { author: true, mentions: true },
  });
  const serialized = serializeComment(withMentions);

  emitToProject(projectId, "comment.created", serialized);

  for (const mentionedUserId of mentionedUserIds) {
    await createNotification({
      workspaceId,
      recipientUserId: mentionedUserId,
      type: "mention",
      payload: { taskId, projectId, commentId: comment.id, authorId },
    });
  }

  return serialized;
}

export async function deleteComment(
  workspaceId: string,
  projectId: string,
  taskId: string,
  commentId: string,
  requesterId: string,
  requesterRole: RoleKey,
) {
  const comment = await prisma.comment.findFirst({
    where: { id: commentId, workspaceId, taskId },
  });
  if (!comment) {
    throw new NotFoundError(COMMENT_NOT_FOUND_MESSAGE);
  }
  if (comment.authorId !== requesterId && !isElevatedRole(requesterRole)) {
    throw new ForbiddenError("You can only delete your own comments.");
  }

  await prisma.comment.delete({ where: { id: commentId } });
  emitToProject(projectId, "comment.deleted", { id: commentId, taskId });
}
