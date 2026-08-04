import { formatUserName } from "./user-display.js";

/**
 * Mention token convention (must match apps/api's MENTION_TOKEN_PATTERN /
 * packages/shared/src/dto/comment.ts): the mention-autocomplete inserts
 * opaque `@[userId]` tokens into the raw comment body. This module only
 * handles turning those tokens into friendly `@DisplayName` text for
 * *display* — the raw token is always what's actually stored/sent.
 */
const MENTION_TOKEN_PATTERN = /@\[([^\]]+)\]/g;

/**
 * Resolves a mentioned userId to display text, preferring the per-comment
 * `mentions` snapshot (frozen at comment-creation time, and the only source
 * that still knows a removed/deleted user's real name — see D16 in the
 * account-deletion architecture handoff) over the live workspace-member
 * list, which degrades a removed/deleted user's `@mention` to a bare
 * "@someone" today. Falls back to "someone" only if neither source knows
 * this userId.
 */
export function renderCommentBody(
  body: string,
  members: { userId: string; displayName: string }[],
  mentions: { userId: string; displayName: string; isDeleted: boolean }[] = [],
): string {
  const mentionsById = new Map(mentions.map((m) => [m.userId, m]));
  const membersById = new Map(members.map((m) => [m.userId, m.displayName]));
  return body.replace(MENTION_TOKEN_PATTERN, (_match, userId: string) => {
    const mention = mentionsById.get(userId);
    if (mention) {
      return `@${formatUserName(mention.displayName, mention.isDeleted)}`;
    }
    const liveDisplayName = membersById.get(userId);
    if (liveDisplayName) {
      return `@${liveDisplayName}`;
    }
    return "@someone";
  });
}
