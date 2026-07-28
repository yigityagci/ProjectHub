import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api.js";
import type { Task } from "./task-types.js";

interface WorkspaceMember {
  userId: string;
  email: string;
  displayName: string;
}

interface Label {
  id: string;
  name: string;
  color: string;
}

interface Dependency {
  id: string;
  blockedTaskId: string;
  blockingTaskId: string;
}

const CAN_EDIT_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER", "MEMBER"]);
const CAN_DELETE_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);
const CAN_MANAGE_DEPENDENCY_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

function formatDateInput(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function formatDateTime(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function TaskDetailModal({
  workspaceId,
  projectId,
  taskId,
  role,
  allTasks,
  onClose,
  onUpdated,
  onDeleted,
}: {
  workspaceId: string;
  projectId: string;
  taskId: string;
  role: string | null;
  allTasks: Task[];
  onClose: () => void;
  onUpdated: (task: Task) => void;
  onDeleted: (taskId: string) => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conflictTask, setConflictTask] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");

  const canEdit = role !== null && CAN_EDIT_ROLES.has(role) && !conflictTask;
  const canDelete = role !== null && CAN_DELETE_ROLES.has(role);
  const canManageDependencies = role !== null && CAN_MANAGE_DEPENDENCY_ROLES.has(role);

  const base = `/api/workspaces/${workspaceId}/projects/${projectId}`;

  function applyTask(t: Task) {
    setTask(t);
    setTitle(t.title);
    setDescription(t.description ?? "");
    setPriority(t.priority);
    setStartDate(formatDateInput(t.startDate));
    setDueDate(formatDateInput(t.dueDate));
  }

  async function load() {
    try {
      const [taskRes, membersRes, labelsRes, depsRes] = await Promise.all([
        api.get<{ task: Task }>(`${base}/tasks/${taskId}`),
        api.get<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspaceId}/members`),
        api.get<{ labels: Label[] }>(`${base}/labels`),
        api.get<{ dependencies: Dependency[] }>(`${base}/tasks/${taskId}/dependencies`),
      ]);
      applyTask(taskRes.task);
      setMembers(membersRes.members);
      setLabels(labelsRes.labels);
      setDependencies(depsRes.dependencies);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this task.");
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  async function handleReload() {
    setConflictTask(null);
    setError(null);
    await load();
  }

  async function handleSave() {
    if (!task) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.patch<{ task: Task }>(`${base}/tasks/${taskId}`, {
        version: task.version,
        title,
        description: description || undefined,
        priority,
        startDate: startDate ? new Date(startDate).toISOString() : null,
        dueDate: dueDate ? new Date(dueDate).toISOString() : null,
      });
      applyTask(res.task);
      onUpdated(res.task);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { currentTask?: Task } | undefined;
        if (body?.currentTask) {
          setConflictTask(body.currentTask);
        } else {
          await handleReload();
        }
      } else {
        setError(err instanceof ApiError ? err.message : "Could not save this task.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this task? This cannot be undone.")) return;
    try {
      await api.delete(`${base}/tasks/${taskId}`);
      onDeleted(taskId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete this task.");
    }
  }

  async function handleToggleAssignee(userId: string, assigned: boolean) {
    try {
      if (assigned) {
        await api.delete(`${base}/tasks/${taskId}/assignees/${userId}`);
      } else {
        await api.post(`${base}/tasks/${taskId}/assignees`, { userId });
      }
      const refreshed = await api.get<{ task: Task }>(`${base}/tasks/${taskId}`);
      applyTask(refreshed.task);
      onUpdated(refreshed.task);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update assignees.");
    }
  }

  async function handleToggleLabel(labelId: string, attached: boolean) {
    try {
      if (attached) {
        await api.delete(`${base}/tasks/${taskId}/labels/${labelId}`);
      } else {
        await api.post(`${base}/tasks/${taskId}/labels/${labelId}`);
      }
      const refreshed = await api.get<{ task: Task }>(`${base}/tasks/${taskId}`);
      applyTask(refreshed.task);
      onUpdated(refreshed.task);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update labels.");
    }
  }

  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  async function handleCreateSubtask() {
    if (!newSubtaskTitle.trim()) return;
    try {
      await api.post(`${base}/tasks`, { title: newSubtaskTitle.trim(), parentTaskId: taskId });
      setNewSubtaskTitle("");
      const refreshed = await api.get<{ task: Task }>(`${base}/tasks/${taskId}`);
      applyTask(refreshed.task);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create subtask.");
    }
  }

  const [blockingTaskChoice, setBlockingTaskChoice] = useState("");
  async function handleAddDependency() {
    if (!blockingTaskChoice) return;
    try {
      await api.post(`${base}/tasks/${taskId}/dependencies`, { blockingTaskId: blockingTaskChoice });
      setBlockingTaskChoice("");
      const depsRes = await api.get<{ dependencies: Dependency[] }>(`${base}/tasks/${taskId}/dependencies`);
      setDependencies(depsRes.dependencies);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this dependency.");
    }
  }

  async function handleRemoveDependency(depId: string) {
    try {
      await api.delete(`${base}/tasks/${taskId}/dependencies/${depId}`);
      setDependencies((prev) => prev.filter((d) => d.id !== depId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove this dependency.");
    }
  }

  if (!task) {
    return (
      <div className="ph-modal-overlay" onClick={onClose}>
        <div className="ph-modal" onClick={(e) => e.stopPropagation()}>
          <p>Loading task...</p>
        </div>
      </div>
    );
  }

  const subtasks = allTasks.filter((t) => t.parentTaskId === task.id);
  const assignedUserIds = new Set(task.assignees.map((a) => a.userId));
  const attachedLabelIds = new Set(task.labels.map((l) => l.labelId));
  const dependencyCandidates = allTasks.filter(
    (t) => t.id !== task.id && !dependencies.some((d) => d.blockingTaskId === t.id),
  );

  return (
    <div className="ph-modal-overlay" onClick={onClose}>
      <div className="ph-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ph-modal-header">
          {canEdit ? (
            <input
              className="ph-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Task title"
            />
          ) : (
            <h2 style={{ margin: 0 }}>{task.title}</h2>
          )}
          <button className="ph-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {conflictTask && (
          <div className="ph-conflict-banner">
            <span>
              This task was changed while you were editing it (last updated{" "}
              {formatDateTime(conflictTask.updatedAt)}). Your changes may conflict.
            </span>
            <button className="ph-button ph-button-secondary" style={{ width: "auto" }} onClick={handleReload}>
              Reload
            </button>
          </div>
        )}

        {error && <div className="ph-alert ph-alert-error">{error}</div>}

        <div className="ph-modal-columns">
          <div>
            <div className="ph-modal-section">
              <h3>Description</h3>
              {canEdit ? (
                <textarea
                  rows={5}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Add a description..."
                />
              ) : (
                <p>{task.description || "No description."}</p>
              )}
            </div>

            <div className="ph-modal-section">
              <h3>Priority</h3>
              {canEdit ? (
                <select value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="ph-badge">{task.priority}</span>
              )}
            </div>

            <div className="ph-modal-section">
              <h3>Dates</h3>
              {canEdit ? (
                <div style={{ display: "flex", gap: "0.75rem" }}>
                  <div className="ph-field">
                    <label>Start</label>
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  </div>
                  <div className="ph-field">
                    <label>Due</label>
                    <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                  </div>
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: "0.85rem" }}>
                  {task.startDate ? formatDateInput(task.startDate) : "No start date"} —{" "}
                  {task.dueDate ? formatDateInput(task.dueDate) : "No due date"}
                </p>
              )}
            </div>

            {canEdit && (
              <button className="ph-button" style={{ width: "auto" }} onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save changes"}
              </button>
            )}

            {canDelete && (
              <button
                className="ph-button ph-button-secondary"
                style={{ width: "auto", marginLeft: "0.6rem", borderColor: "var(--ph-error)", color: "var(--ph-error)" }}
                onClick={handleDelete}
              >
                Delete task
              </button>
            )}
          </div>

          <div>
            <div className="ph-modal-section">
              <h3>Assignees</h3>
              <ul className="ph-assignee-list">
                {task.assignees.length === 0 && <li style={{ border: "none" }}>No one assigned yet.</li>}
                {task.assignees.map((a) => (
                  <li key={a.userId}>
                    <span>{a.displayName}</span>
                    {canEdit && (
                      <button className="ph-remove-btn" onClick={() => handleToggleAssignee(a.userId, true)}>
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {canEdit && (
                <select
                  value=""
                  onChange={(e) => e.target.value && handleToggleAssignee(e.target.value, false)}
                  style={{ marginTop: "0.5rem" }}
                >
                  <option value="">Assign someone...</option>
                  {members
                    .filter((m) => !assignedUserIds.has(m.userId))
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.displayName}
                      </option>
                    ))}
                </select>
              )}
            </div>

            <div className="ph-modal-section">
              <h3>Labels</h3>
              <div className="ph-task-card-meta">
                {labels.map((l) => {
                  const attached = attachedLabelIds.has(l.id);
                  return (
                    <button
                      key={l.id}
                      className="ph-label-chip"
                      style={{
                        background: attached ? l.color : "transparent",
                        color: attached ? "white" : l.color,
                        border: `1px solid ${l.color}`,
                        cursor: canEdit ? "pointer" : "default",
                      }}
                      disabled={!canEdit}
                      onClick={() => handleToggleLabel(l.id, attached)}
                    >
                      {l.name}
                    </button>
                  );
                })}
                {labels.length === 0 && <span style={{ fontSize: "0.85rem" }}>No labels in this project.</span>}
              </div>
            </div>

            <div className="ph-modal-section">
              <h3>Subtasks</h3>
              <ul className="ph-subtask-list">
                {subtasks.length === 0 && <li style={{ border: "none" }}>No subtasks.</li>}
                {subtasks.map((s) => (
                  <li key={s.id}>
                    <span>{s.title}</span>
                  </li>
                ))}
              </ul>
              {canEdit && !task.parentTaskId && (
                <div className="ph-inline-form" style={{ marginTop: "0.5rem" }}>
                  <input
                    placeholder="New subtask title"
                    value={newSubtaskTitle}
                    onChange={(e) => setNewSubtaskTitle(e.target.value)}
                  />
                  <button className="ph-button ph-button-secondary" onClick={handleCreateSubtask}>
                    Add
                  </button>
                </div>
              )}
            </div>

            <div className="ph-modal-section">
              <h3>Dependencies (blocked by)</h3>
              <ul className="ph-dependency-list">
                {dependencies.length === 0 && <li style={{ border: "none" }}>No dependencies.</li>}
                {dependencies.map((d) => {
                  const blockingTask = allTasks.find((t) => t.id === d.blockingTaskId);
                  return (
                    <li key={d.id}>
                      <span>Blocked by: {blockingTask?.title ?? d.blockingTaskId}</span>
                      {canManageDependencies && (
                        <button className="ph-remove-btn" onClick={() => handleRemoveDependency(d.id)}>
                          Remove
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {canManageDependencies && (
                <div className="ph-inline-form" style={{ marginTop: "0.5rem" }}>
                  <select value={blockingTaskChoice} onChange={(e) => setBlockingTaskChoice(e.target.value)}>
                    <option value="">Add a blocking task...</option>
                    {dependencyCandidates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                  <button className="ph-button ph-button-secondary" onClick={handleAddDependency}>
                    Add
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
