import type { Prisma, ActivityEvent } from "@prisma/client";
import type { ActivityEventType } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { emitToProject } from "../realtime/realtime.js";

type PrismaOrTx = typeof prisma | Prisma.TransactionClient;

export interface RecordActivityEventInput {
  workspaceId: string;
  projectId: string;
  actorId: string;
  type: ActivityEventType;
  /**
   * Human-readable context denormalized at event-creation time (task
   * title, from/to column names, actor display name, ...) so the feed can
   * render every event without re-joining to Task/BoardColumn/User, which
   * may have changed or been deleted by the time the feed is read.
   */
  payload: Record<string, unknown>;
}

export function serializeActivityEvent(event: ActivityEvent) {
  return {
    id: event.id,
    projectId: event.projectId,
    actorId: event.actorId,
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
      actorId: input.actorId,
      type: input.type,
      payload: input.payload as object,
    },
  });
}

/**
 * Broadcasts an already-persisted ActivityEvent over the project's
 * real-time room. Callers must only invoke this AFTER the write (and its
 * enclosing transaction, if any) has actually committed — never from
 * inside a `$transaction` callback — so a subsequently rolled-back
 * mutation can never produce a phantom live event.
 */
export function broadcastActivityEvent(event: ActivityEvent): void {
  emitToProject(event.projectId, "activity.created", serializeActivityEvent(event));
}

export interface ListActivityEventsOptions {
  limit: number;
  cursor?: string;
}

/**
 * Most-recent-first, cursor-paginated listing for a single project.
 * `cursor` is the `id` of the last event returned on the previous page.
 */
export async function listActivityEvents(projectId: string, opts: ListActivityEventsOptions) {
  const events = await prisma.activityEvent.findMany({
    where: { projectId },
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
