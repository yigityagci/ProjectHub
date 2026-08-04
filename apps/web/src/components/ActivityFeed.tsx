import { useEffect, useState } from "react";
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

function describeActivityEvent(e: ActivityEvent): string {
  // `payload.actorDisplayName` is a frozen JSON snapshot (see
  // ActivityEvent.payload in schema.prisma), never re-resolved — the
  // "(deleted account)" suffix is applied here from the live `actorIsDeleted`
  // flag (driven by the real actorId FK, see activity.service.ts), not from
  // anything inside the payload itself.
  const rawActor = (e.payload.actorDisplayName as string | undefined) ?? "Someone";
  const actor = formatUserName(rawActor, e.actorIsDeleted);
  switch (e.type) {
    case "task_created":
      return `${actor} created task "${e.payload.taskTitle ?? ""}"`;
    case "task_moved":
      return `${actor} moved "${e.payload.taskTitle ?? ""}" from ${e.payload.fromColumnName ?? "?"} to ${e.payload.toColumnName ?? "?"}`;
    case "task_assigned":
      return `${actor} assigned "${e.payload.taskTitle ?? ""}" to ${e.payload.assigneeDisplayName ?? "someone"}`;
    case "comment_added":
      return `${actor} commented on "${e.payload.taskTitle ?? ""}"`;
    case "milestone_completed":
      return `${actor} completed milestone "${e.payload.milestoneName ?? ""}"`;
    default:
      return "Activity";
  }
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
              {describeActivityEvent(e)}
              <span className="ph-activity-time">{new Date(e.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
