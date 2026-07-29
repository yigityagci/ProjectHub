import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { getSocket } from "../lib/socket.js";

export interface AppNotification {
  id: string;
  workspaceId: string;
  type: "mention" | "task_assigned" | "comment_reply";
  payload: {
    taskId?: string;
    projectId?: string;
    categoryId?: string;
    commentId?: string;
    assignedBy?: string;
    authorId?: string;
  };
  readAt: string | null;
  createdAt: string;
}

function describeNotification(n: AppNotification): string {
  switch (n.type) {
    case "mention":
      return "You were mentioned in a comment.";
    case "task_assigned":
      return "You were assigned to a task.";
    case "comment_reply":
      return "Someone replied to your comment.";
    default:
      return "You have a new notification.";
  }
}

/**
 * Minimal notification bell + dropdown for the app shell. Loads the user's
 * own notifications via REST on mount (covers anything delivered while
 * offline) and live-prepends anything pushed over the Phase 3 real-time
 * layer while connected (`notification.created`, delivered to the user's
 * own `user:{id}` room).
 */
export default function NotificationBell() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  async function load() {
    try {
      const res = await api.get<{ notifications: AppNotification[] }>("/api/notifications");
      setNotifications(res.notifications);
    } catch {
      // Non-critical for page function; fail silently.
    }
  }

  useEffect(() => {
    load();
    const socket = getSocket();
    const onCreated = (n: AppNotification) => {
      setNotifications((prev) => [n, ...prev]);
    };
    socket.on("notification.created", onCreated);
    return () => {
      socket.off("notification.created", onCreated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  async function handleMarkRead(n: AppNotification) {
    if (!n.readAt) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      await api.post(`/api/notifications/${n.id}/read`).catch(() => undefined);
    }
    setOpen(false);
    if (n.payload.projectId && n.payload.taskId && n.payload.categoryId) {
      navigate(
        `/workspace/${n.workspaceId}/projects/${n.payload.projectId}/categories/${n.payload.categoryId}/board`,
      );
    } else if (n.payload.projectId) {
      // Older notifications (created before categories existed) or ones
      // missing a categoryId fall back to the category picker rather than
      // a broken/guessed board URL.
      navigate(`/workspace/${n.workspaceId}/projects/${n.payload.projectId}/categories`);
    }
  }

  async function handleMarkAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    await api.post("/api/notifications/read-all").catch(() => undefined);
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        className="ph-button ph-button-secondary"
        style={{ width: "auto", position: "relative" }}
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
      >
        Notifications
        {unreadCount > 0 && (
          <span
            style={{
              marginLeft: "0.4rem",
              background: "var(--ph-error, #dc2626)",
              color: "white",
              borderRadius: "999px",
              padding: "0 0.4rem",
              fontSize: "0.7rem",
            }}
          >
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="ph-card ph-notification-dropdown"
          style={{
            position: "absolute",
            right: 0,
            top: "2.4rem",
            width: "320px",
            maxHeight: "360px",
            overflowY: "auto",
            zIndex: 20,
            padding: "0.75rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.85rem" }}>Notifications</strong>
            {unreadCount > 0 && (
              <button
                className="ph-button ph-button-secondary"
                style={{ width: "auto", fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                onClick={handleMarkAllRead}
              >
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <p style={{ fontSize: "0.8rem", color: "var(--ph-muted)" }}>No notifications yet.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: "0.5rem 0 0", padding: 0 }}>
              {notifications.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => handleMarkRead(n)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      background: n.readAt ? "transparent" : "rgba(59,130,246,0.08)",
                      border: "none",
                      borderBottom: "1px solid var(--ph-border)",
                      padding: "0.5rem 0.25rem",
                      cursor: "pointer",
                      fontSize: "0.8rem",
                    }}
                  >
                    <div>{describeNotification(n)}</div>
                    <div style={{ fontSize: "0.7rem", color: "var(--ph-muted)" }}>
                      {new Date(n.createdAt).toLocaleString()}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
