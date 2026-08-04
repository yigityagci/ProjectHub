import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api.js";
import type { SettingsTabProps } from "./types.js";

export default function NotificationsTab({ settings, onSettingsChange }: SettingsTabProps) {
  const [mention, setMention] = useState(settings.notifications.mention);
  const [taskAssigned, setTaskAssigned] = useState(settings.notifications.task_assigned);
  const [dueDateSoon, setDueDateSoon] = useState(settings.notifications.due_date_soon);
  const [commentReply, setCommentReply] = useState(settings.notifications.comment_reply);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const dirty =
    mention !== settings.notifications.mention ||
    taskAssigned !== settings.notifications.task_assigned ||
    dueDateSoon !== settings.notifications.due_date_soon ||
    commentReply !== settings.notifications.comment_reply;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const res = await api.patch<{ user: typeof settings }>("/api/auth/me/preferences", {
        notifications: {
          mention,
          task_assigned: taskAssigned,
          due_date_soon: dueDateSoon,
          comment_reply: commentReply,
        },
      });
      onSettingsChange(res.user);
      setSuccess("Preferences saved");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>Notifications</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Choose which notifications you'd like to receive.
      </p>
      {error && <div className="ph-alert ph-alert-error">{error}</div>}
      {success && <div className="ph-alert ph-alert-success">{success}</div>}
      <form onSubmit={handleSubmit}>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", marginBottom: "0.9rem" }}>
          <input type="checkbox" checked={mention} onChange={(e) => setMention(e.target.checked)} />
          <span>
            <strong>Mentions</strong>
            <div className="ph-subtitle" style={{ margin: 0 }}>
              You're mentioned in a task or comment
            </div>
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", marginBottom: "0.9rem" }}>
          <input type="checkbox" checked={taskAssigned} onChange={(e) => setTaskAssigned(e.target.checked)} />
          <span>
            <strong>Task assignments</strong>
            <div className="ph-subtitle" style={{ margin: 0 }}>
              You're assigned to a task
            </div>
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", marginBottom: "0.9rem" }}>
          <input type="checkbox" checked={dueDateSoon} onChange={(e) => setDueDateSoon(e.target.checked)} />
          <span>
            <strong>Due date reminders</strong>
            <div className="ph-subtitle" style={{ margin: 0 }}>
              A task you're assigned to is due soon
            </div>
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", marginBottom: "1rem" }}>
          <input type="checkbox" checked={commentReply} onChange={(e) => setCommentReply(e.target.checked)} />
          <span>
            <strong>Replies to your comments</strong>
            <div className="ph-subtitle" style={{ margin: 0 }}>
              Someone replies to your comment
            </div>
          </span>
        </label>
        <button className="ph-button" type="submit" disabled={saving || !dirty} style={{ width: "auto" }}>
          {saving ? "Saving..." : "Save preferences"}
        </button>
      </form>
    </div>
  );
}
