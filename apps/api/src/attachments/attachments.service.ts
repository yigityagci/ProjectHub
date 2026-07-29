import crypto from "node:crypto";
import { isAllowedAttachmentContentType, type RoleKey } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { env } from "../config/env.js";
import { NotFoundError, ForbiddenError, ValidationError } from "../core/errors.js";
import { isElevatedRole } from "../rbac/authorize.js";
import { storageProvider } from "../storage/local-disk-provider.js";
import { emitToCategory } from "../realtime/realtime.js";

const ATTACHMENT_NOT_FOUND_MESSAGE = "This attachment doesn't exist on this task.";

function serializeAttachment(attachment: {
  id: string;
  taskId: string;
  uploaderId: string;
  uploader: { id: string; displayName: string; email: string };
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}) {
  return {
    id: attachment.id,
    taskId: attachment.taskId,
    uploaderId: attachment.uploaderId,
    uploaderDisplayName: attachment.uploader.displayName,
    uploaderEmail: attachment.uploader.email,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt,
  };
}

export async function listAttachments(workspaceId: string, categoryId: string, taskId: string) {
  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId, categoryId } });
  if (!task) {
    throw new NotFoundError("This task doesn't exist in this category.");
  }
  const attachments = await prisma.attachment.findMany({
    where: { taskId, workspaceId },
    include: { uploader: true },
    orderBy: { createdAt: "desc" },
  });
  return attachments.map(serializeAttachment);
}

export interface CreateAttachmentParams {
  workspaceId: string;
  categoryId: string;
  taskId: string;
  uploaderId: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

/**
 * Validates the content-type allowlist and size limit, writes the file
 * through the StorageProvider abstraction under a server-generated opaque
 * storage key (never derived from the client-supplied filename, to avoid
 * path traversal), and records the Attachment row.
 */
export async function createAttachment(params: CreateAttachmentParams) {
  const { workspaceId, categoryId, taskId, uploaderId, filename, contentType, data } = params;

  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId, categoryId } });
  if (!task) {
    throw new NotFoundError("This task doesn't exist in this category.");
  }

  if (!isAllowedAttachmentContentType(contentType)) {
    throw new ValidationError(`Files of type "${contentType}" are not allowed.`);
  }
  if (data.length > env.UPLOAD_MAX_SIZE_BYTES) {
    throw new ValidationError(
      `This file is too large. The maximum upload size is ${Math.floor(env.UPLOAD_MAX_SIZE_BYTES / (1024 * 1024))}MB.`,
    );
  }

  const storageKey = crypto.randomUUID();
  await storageProvider.put(storageKey, data);

  const attachment = await prisma.attachment.create({
    data: {
      workspaceId,
      taskId,
      uploaderId,
      filename: filename.slice(0, 255),
      contentType,
      sizeBytes: data.length,
      storageKey,
    },
    include: { uploader: true },
  });

  const serialized = serializeAttachment(attachment);
  emitToCategory(categoryId, "attachment.created", serialized);
  return serialized;
}

export async function getAttachmentForDownload(
  workspaceId: string,
  categoryId: string,
  taskId: string,
  attachmentId: string,
) {
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, workspaceId, taskId, task: { categoryId } },
  });
  if (!attachment) {
    throw new NotFoundError(ATTACHMENT_NOT_FOUND_MESSAGE);
  }
  const data = await storageProvider.get(attachment.storageKey);
  return { attachment, data };
}

export async function deleteAttachment(
  workspaceId: string,
  categoryId: string,
  taskId: string,
  attachmentId: string,
  requesterId: string,
  requesterRole: RoleKey,
) {
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, workspaceId, taskId, task: { categoryId } },
  });
  if (!attachment) {
    throw new NotFoundError(ATTACHMENT_NOT_FOUND_MESSAGE);
  }
  if (attachment.uploaderId !== requesterId && !isElevatedRole(requesterRole)) {
    throw new ForbiddenError("You can only delete your own attachments.");
  }

  await prisma.attachment.delete({ where: { id: attachmentId } });
  await storageProvider.delete(attachment.storageKey);
  emitToCategory(categoryId, "attachment.deleted", { id: attachmentId, taskId });
}
