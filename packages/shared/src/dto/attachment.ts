/**
 * Content-type allowlist for task attachment uploads. Deliberately narrow
 * (common documents/images/archives) rather than exhaustive — scaffolding
 * tier per the Phase 4 scope. The size limit itself is configurable via the
 * API's `UPLOAD_MAX_SIZE_BYTES` env var (see apps/api/src/config/env.ts),
 * not hard-coded here.
 */
export const ALLOWED_ATTACHMENT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export type AllowedAttachmentContentType = (typeof ALLOWED_ATTACHMENT_CONTENT_TYPES)[number];

export function isAllowedAttachmentContentType(value: string): boolean {
  return (ALLOWED_ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(value);
}
