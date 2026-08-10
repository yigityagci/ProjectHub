import type { Prisma, ActivityEvent, UserStatus } from "@prisma/client";
import type { ActivityEventType, RoleKey } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { emitToProject, emitToCategory } from "../realtime/realtime.js";
import { listVisibleCategoryIdsForUser } from "../projects/categories.service.js";
import { isDeletedUser } from "../users/user-serialization.js";

type PrismaOrTx = typeof prisma | Prisma.TransactionClient;

/**
 * The AI client that acted on a human's behalf, if this event was produced
 * by an MCP tool call rather than an ordinary REST-route action (see mcp/).
 * `agentLabel` is a snapshot of the token's label AT THE TIME of the
 * action — never re-resolved later, same "frozen at write time" precedent
 * as every other denormalized field in `payload` (see the module doc
 * comment above).
 */
export interface ActingAgent {
  agentTokenId: string;
  agentLabel: string;
}

export interface RecordActivityEventInput {
  workspaceId: string;
  projectId: string;
  /**
   * Present for every category-scoped event (task_created/task_moved/
   * task_assigned/comment_added on a task, all of which now have a
   * category available via the category-scoped route context). Left
   * undefined/null for project-level events with no category in scope
   * (milestone_completed — milestones remain project-scoped, not
   * category-scoped).
   */
  categoryId?: string | null;
  actorId: string;
  type: ActivityEventType;
  /**
   * Human-readable context denormalized at event-creation time (task
   * title, from/to column names, actor display name, ...) so the feed can
   * render every event without re-joining to Task/BoardColumn/User, which
   * may have changed or been deleted by the time the feed is read.
   */
  payload: Record<string, unknown>;
  /**
   * Present only when this event was produced by an MCP tool call.
   * `actorId` above is ALWAYS the responsible human, unconditionally,
   * regardless of whether `via` is present — this field only ever adds
   * attribution, never changes who is credited with the action.
   */
  via?: ActingAgent;
}

/**
 * `actor` is optional: `broadcastActivityEvent` calls this right after a
 * plain `activityEvent.create` (no actor loaded — the freshly-persisted row
 * has no relations attached), while `listActivityEvents` below loads the
 * real actor FK (`{ actor: { select: { status: true } } }`) so `actorIsDeleted`
 * reflects live account status rather than the frozen `payload.actorDisplayName`
 * JSON snapshot, which is never re-resolved (see the module doc comment on
 * ActivityEvent in schema.prisma for why the payload is frozen at write time).
 */
export function serializeActivityEvent(event: ActivityEvent & { actor?: { status: UserStatus } | null }) {
  return {
    id: event.id,
    projectId: event.projectId,
    categoryId: event.categoryId,
    actorId: event.actorId,
    actorIsDeleted: event.actor ? isDeletedUser(event.actor) : false,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

/**
 * Persists an ActivityEvent row via `client` (which may be a Prisma
 * `$transaction` callback client, so the row commits atomically together
 * with the mutation that triggered it). Deliberately does NOT broadcast —
 * see `broadcastActivityEvent` below for why that's a separate step.
 */
export async function createActivityEvent(
  client: PrismaOrTx,
  input: RecordActivityEventInput,
): Promise<ActivityEvent> {
  return client.activityEvent.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      categoryId: input.categoryId ?? null,
      // actorId is written UNCONDITIONALLY from input.actorId — never
      // derived from or overridden by `via` — so the responsible human is
      // always credited, regardless of whether an AI client acted for them.
      actorId: input.actorId,
      viaAgentTokenId: input.via?.agentTokenId ?? null,
      type: input.type,
      // `viaAgentLabel` is spread in LAST (after the caller's own payload
      // fields) so this function is the single writer of that key across
      // the whole codebase — no caller ever sets payload.viaAgentLabel
      // itself; it only ever arrives via the `via` parameter above. Absent
      // entirely (not even `undefined`) for a manual, non-agent action.
      payload: {
        ...input.payload,
        ...(input.via ? { viaAgentLabel: input.via.agentLabel } : {}),
      } as object,
    },
  });
}

/**
 * Broadcasts an already-persisted ActivityEvent live. Callers must only
 * invoke this AFTER the write (and its enclosing transaction, if any) has
 * actually committed — never from inside a `$transaction` callback — so a
 * subsequently rolled-back mutation can never produce a phantom live event.
 *
 * Category-scoped events (categoryId set) broadcast to that category's
 * room ONLY, not also the parent project's room — a user who can see the
 * project overall but not this specific (possibly private) category must
 * never receive its live activity feed entries. Project-level events
 * (categoryId null, e.g. milestone_completed) broadcast to the project's
 * room as before.
 */
export function broadcastActivityEvent(event: ActivityEvent): void {
  if (event.categoryId) {
    emitToCategory(event.categoryId, "activity.created", serializeActivityEvent(event));
  } else {
    emitToProject(event.projectId, "activity.created", serializeActivityEvent(event));
  }
}

export interface ListActivityEventsOptions {
  limit: number;
  cursor?: string;
}

/**
 * Most-recent-first, cursor-paginated listing for a single project.
 * `cursor` is the `id` of the last event returned on the previous page.
 *
 * `viewer`, when provided, narrows the feed to events the caller may
 * actually see: events with a null `categoryId` (project-level events)
 * remain visible to anyone who can already see the project (unchanged);
 * events belonging to a category are only included if that category is in
 * the caller's visible-category-id set (same access rule as category
 * listing/analytics — see categories.service.ts#listVisibleCategoryIdsForUser).
 * Omitting `viewer` preserves the old unfiltered behavior for internal
 * callers that have already done their own category-scoping (e.g. a
 * category-scoped activity view, if ever added).
 */
export interface ActivityViewer {
  userId: string;
  roleKey: RoleKey;
}

export async function listActivityEvents(
  projectId: string,
  opts: ListActivityEventsOptions,
  viewer?: ActivityViewer,
) {
  const categoryFilter = viewer
    ? await listVisibleCategoryIdsForUser(projectId, viewer.userId, viewer.roleKey)
    : null;

  const events = await prisma.activityEvent.findMany({
    where: {
      projectId,
      ...(categoryFilter
        ? { OR: [{ categoryId: null }, { categoryId: { in: categoryFilter } }] }
        : {}),
    },
    include: { actor: { select: { status: true } } },
    orderBy: { createdAt: "desc" },
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = events.length > opts.limit;
  const page = hasMore ? events.slice(0, opts.limit) : events;

  return {
    events: page.map(serializeActivityEvent),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
