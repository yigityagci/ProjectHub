import { useState } from "react";
import type { Task } from "./task-types.js";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: Task["priority"];
  startDate?: string | null;
  dueDate?: string | null;
}

/**
 * Task-creation popup, opened via the "+" button on a Kanban column header
 * (see KanbanBoardPage.tsx). Deliberately limited to the fields
 * `createTaskSchema` (packages/shared/src/dto/task.ts) accepts at creation
 * time — title/description/priority/startDate/dueDate. Assignees, labels,
 * milestone, subtasks and dependencies are all set via separate endpoints
 * after creation, so this modal hands off to `TaskDetailModal` immediately
 * on success instead of trying to collect them upfront.
 */
export default function CreateTaskModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: CreateTaskInput) => Promise<Task | null>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const canSubmit = title.trim().length > 0 && !creating;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    setError(null);
    try {
      const created = await onCreate({
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        startDate: startDate ? new Date(startDate).toISOString() : null,
        dueDate: dueDate ? new Date(dueDate).toISOString() : null,
      });
      if (!created) {
        // The parent's create call already surfaced a toast on failure;
        // keep the modal open with the user's input intact so they can retry.
        setCreating(false);
      }
      // On success the parent closes this modal itself (and opens
      // TaskDetailModal for the new task), so there's nothing more to do here.
    } catch {
      setError("Could not create this task. Please try again.");
      setCreating(false);
    }
  }

  return (
    <div className="ph-modal-overlay" onClick={onClose}>
      <div className="ph-modal" style={{ maxWidth: "480px" }} onClick={(e) => e.stopPropagation()}>
        <div className="ph-modal-header">
          <h2 style={{ margin: 0 }}>New task</h2>
          <button className="ph-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error && <div className="ph-alert ph-alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="ph-field">
            <label>Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              autoFocus
              aria-label="Task title"
            />
          </div>

          <div className="ph-field">
            <label>Description</label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a description... (optional)"
            />
          </div>

          <div className="ph-field">
            <label>Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", gap: "0.75rem" }}>
            <div className="ph-field" style={{ flex: 1 }}>
              <label>Start date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="ph-field" style={{ flex: 1 }}>
              <label>Due date</label>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>

          <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.5rem" }}>
            <button type="submit" className="ph-button" style={{ width: "auto" }} disabled={!canSubmit}>
              {creating ? "Creating..." : "Create"}
            </button>
            <button
              type="button"
              className="ph-button ph-button-secondary"
              style={{ width: "auto" }}
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
