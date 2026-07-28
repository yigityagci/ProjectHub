import { z } from "zod";

/**
 * Mention parsing convention: the frontend's mention-autocomplete inserts
 * opaque `@[userId]` tokens into the comment body (never free-text
 * `@displayName`/`@email` matching, which is ambiguous with duplicates and
 * requires guessing intent server-side). The server re-parses these tokens
 * at comment-creation time and only honors tokens that resolve to an active
 * workspace member.
 */
export const MENTION_TOKEN_PATTERN = /@\[([^\]]+)\]/g;

/**
 * Strict allowlist for comment creation. `authorId`/`taskId`/`workspaceId`
 * are always derived server-side from the URL/session and never accepted
 * from the client.
 */
export const createCommentSchema = z
  .object({
    body: z
      .string({ required_error: "Comment body is required." })
      .trim()
      .min(1, "Comment body is required.")
      .max(10000, "Comment must be 10,000 characters or fewer."),
  })
  .strict();
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
