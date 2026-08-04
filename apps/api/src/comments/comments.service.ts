import type { UserStatus } from "@prisma/client";
import type { CreateCommentInput } from "@projecthub/shared";
import { MENTION_TOKEN_PATTERN } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { NotFoundError, ForbiddenError } from "../core/errors.js";
import { isElevatedRole } from "../rbac/authorize.js";
import type { RoleKey } from "@projecthub/shared";
import { emitToCategory } from "../realtime/realtime.js";
import { createNotification } from "../notifications/notifications.service.js";
import { createActivityEvent, broadcastActivityEvent } from "../activity/activity.service.js";
import { isDeletedUser } from "../users/user-serialization.js";

const COMMENT_NOT_FOUND_MESSAGE = "This comment doesn't exist on this task.";

/**
 * Shared `include` shape used at every comment.findMany/create/
 * findUniqueOrThrow call site in this file, so they can't drift out of sync
 * with serializeComment's expected shape (in particular the author/mention
 * `status` columns needed for the "(deleted account)" suffix).
 */
const COMMENT_INCLUDE = {
  author: true,
  mentions: {
    include: {
      mentionedUser: {
        select: { id: true, displayName: true, status: true },
      },
    },
  },
} as const;

type CommentWithRelations = {
  id: string;
  taskId: string;
  authorId: string;
  author: { id: string; displayName: string; email: string; status: UserStatus };
  body: string;
  createdAt: Date;
  updatedAt: Date;
  mentions: {
    mentionedUserId: string;
    mentionedUser: { id: string; displayName: string; status: UserStatus };
  }[];
};

function serializeComment(comment: CommentWithRelations) {
  return {
    id: comment.id,
    taskId: comment.taskId,
    authorId: comment.authorId,
    authorDisplayName: comment.author.displayName,
    authorEmail: comment.author.email,
    authorIsDeleted: isDeletedUser(comment.author),
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    mentionedUserIds: comment.mentions.map((m) => m.mentionedUserId),
    mentions: comment.mentions.map((m) => ({
      userId: m.mentionedUser.id,
      displayName: m.mentionedUser.displayName,
      isDeleted: isDeletedUser(m.mentionedUser),
    })),
  };
}

export async function listComments(workspaceId: string, categoryId: string, taskId: string) {
  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId, categoryId } });
  if (!task) {
    throw new NotFoundError("This task doesn't exist in this category.");
  }
  const comments = await prisma.comment.findMany({
    where: { taskId, workspaceId },
    include: COMMENT_INCLUDE,
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
  categoryId: string;
  taskId: string;
  authorId: string;
  authorDisplayName: string;
  input: CreateCommentInput;
}

export async function createComment(params: CreateCommentParams) {
  const { workspaceId, projectId, categoryId, taskId, authorId, authorDisplayName, input } = params;
  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId, categoryId } });
  if (!task) {
    throw new NotFoundError("This task doesn't exist in this category.");
  }

  const mentionedUserIds = await resolveMentionedUserIds(workspaceId, authorId, input.body);

  const { comment, activityEvent } = await prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: { workspaceId, taskId, authorId, body: input.body },
      include: COMMENT_INCLUDE,
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
    const event = await createActivityEvent(tx, {
      workspaceId,
      projectId,
      categoryId,
      actorId: authorId,
      type: "comment_added",
      payload: { taskId, taskTitle: task.title, commentId: created.id, actorDisplayName: authorDisplayName },
    });
    return { comment: created, activityEvent: event };
  });

  const withMentions = await prisma.comment.findUniqueOrThrow({
    where: { id: comment.id },
    include: COMMENT_INCLUDE,
  });
  const serialized = serializeComment(withMentions);

  emitToCategory(categoryId, "comment.created", serialized);
  broadcastActivityEvent(activityEvent);

  for (const mentionedUserId of mentionedUserIds) {
    await createNotification({
      workspaceId,
      recipientUserId: mentionedUserId,
      type: "mention",
      payload: { taskId, projectId, categoryId, commentId: comment.id, authorId },
    });
  }

  return serialized;
}

export async function deleteComment(
  workspaceId: string,
  categoryId: string,
  taskId: string,
  commentId: string,
  requesterId: string,
  requesterRole: RoleKey,
) {
  const comment = await prisma.comment.findFirst({
    where: { id: commentId, workspaceId, taskId, task: { categoryId } },
  });
  if (!comment) {
    throw new NotFoundError(COMMENT_NOT_FOUND_MESSAGE);
  }
  if (comment.authorId !== requesterId && !isElevatedRole(requesterRole)) {
    throw new ForbiddenError("You can only delete your own comments.");
  }

  await prisma.comment.delete({ where: { id: commentId } });
  emitToCategory(categoryId, "comment.deleted", { id: commentId, taskId });
}
