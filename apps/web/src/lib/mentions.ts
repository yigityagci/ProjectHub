/**
 * Mention token convention (must match apps/api's MENTION_TOKEN_PATTERN /
 * packages/shared/src/dto/comment.ts): the mention-autocomplete inserts
 * opaque `@[userId]` tokens into the raw comment body. This module only
 * handles turning those tokens into friendly `@DisplayName` text for
 * *display* — the raw token is always what's actually stored/sent.
 */
const MENTION_TOKEN_PATTERN = /@\[([^\]]+)\]/g;

export function renderCommentBody(
  body: string,
  members: { userId: string; displayName: string }[],
): string {
  const byId = new Map(members.map((m) => [m.userId, m.displayName]));
  return body.replace(MENTION_TOKEN_PATTERN, (_match, userId: string) => `@${byId.get(userId) ?? "someone"}`);
}
