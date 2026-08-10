import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api.js";
import { getSocket } from "../lib/socket.js";
import { formatUserName } from "../lib/user-display.js";

export interface ActivityEvent {
  id: string;
  projectId: string;
  actorId: string;
  actorIsDeleted: boolean;
  type: "task_created" | "task_moved" | "task_assigned" | "comment_added" | "milestone_completed";
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Actor-agnostic description of what happened — every case's wording is
 * identical to what `describeActivityEvent` (pre-split) used to return minus
 * the leading actor mention, so the non-agent rendering path below stays
 * byte-for-byte unchanged.
 */
function describeActivityAction(e: ActivityEvent): string {
  switch (e.type) {
    case "task_created":
      return `created task "${e.payload.taskTitle ?? ""}"`;
    case "task_moved":
      return `moved "${e.payload.taskTitle ?? ""}" from ${e.payload.fromColumnName ?? "?"} to ${e.payload.toColumnName ?? "?"}`;
    case "task_assigned":
      return `assigned "${e.payload.taskTitle ?? ""}" to ${e.payload.assigneeDisplayName ?? "someone"}`;
    case "comment_added":
      return `commented on "${e.payload.taskTitle ?? ""}"`;
    case "milestone_completed":
      return `completed milestone "${e.payload.milestoneName ?? ""}"`;
    default:
      return "";
  }
}

/**
 * Composes the final displayed content for one activity event. When
 * `payload.viaAgentLabel` is present, the action was performed by an
 * MCP-connected AI client acting on behalf of the human actor — the human
 * actor is always the responsible party (never the agent), so it's still
 * named, just with the agent's label bolded and an explicit "via MCP"
 * suffix. When absent, this renders byte-for-byte identical text to the
 * pre-split `describeActivityEvent`'s plain-string output for every existing
 * case — a purely additive change, no wording/structure regression.
 */
function renderActivityEvent(e: ActivityEvent): ReactNode {
  // `payload.actorDisplayName` is a frozen JSON snapshot (see
  // ActivityEvent.payload in schema.prisma), never re-resolved — the
  // "(deleted account)" suffix is applied here from the live `actorIsDeleted`
  // flag (driven by the real actorId FK, see activity.service.ts), not from
  // anything inside the payload itself.
  const rawActor = (e.payload.actorDisplayName as string | undefined) ?? "Someone";
  const actor = formatUserName(rawActor, e.actorIsDeleted);
  const action = describeActivityAction(e);
  if (!action) return "Activity";

  // Present only when the action was performed via an MCP tool call using an
  // agent token (see agent-token.service.ts) — the human actor above is
  // always the responsible party, never the agent, so it's still named here.
  const viaAgentLabel = e.payload?.viaAgentLabel as string | undefined;
  if (viaAgentLabel) {
    return (
      <>
        <strong>{viaAgentLabel}</strong> {action} on behalf of {actor} via MCP
      </>
    );
  }
  return `${actor} ${action}`;
}

/**
 * Reverse-chronological, live-updating activity feed for a single project.
 * Loads the most recent page via REST on mount and live-prepends anything
 * broadcast over the project's real-time room while this component is
 * mounted (`activity.created`, see apps/api/src/activity/activity.service.ts).
 */
export default function ActivityFeed({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ events: ActivityEvent[] }>(
          `/api/workspaces/${workspaceId}/projects/${projectId}/activity?limit=30`,
        );
        if (!cancelled) setEvents(res.events);
      } catch {
        if (!cancelled) setEvents([]);
      }
    })();

    const socket = getSocket();
    const onCreated = (event: ActivityEvent) => {
      if (event.projectId !== projectId) return;
      setEvents((prev) => (prev ? [event, ...prev] : [event]));
    };
    socket.on("activity.created", onCreated);

    return () => {
      cancelled = true;
      socket.off("activity.created", onCreated);
    };
  }, [workspaceId, projectId]);

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>Recent activity</h1>
      {events === null ? (
        <p>Loading...</p>
      ) : events.length === 0 ? (
        <div className="ph-empty-state">No activity yet.</div>
      ) : (
        <ul className="ph-activity-list">
          {events.map((e) => (
            <li key={e.id}>
              {renderActivityEvent(e)}
              <span className="ph-activity-time">{new Date(e.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
