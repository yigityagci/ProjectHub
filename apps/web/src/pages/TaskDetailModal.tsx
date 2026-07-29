import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api.js";
import { getSocket } from "../lib/socket.js";
import { renderCommentBody } from "../lib/mentions.js";
import { IconX } from "../components/Icons.js";
import type { Task, Comment, Attachment } from "./task-types.js";

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
// Comments/attachments reuse the `task.edit` permission server-side (see
// apps/api/src/comments/comments.routes.ts); this mirrors that same
// role set so Viewer/Client see a read-only comment/attachment UI.
const CAN_COMMENT_ROLES = CAN_EDIT_ROLES;
// Author-or-elevated-role deletion rule for comments/attachments.
const ELEVATED_ROLES = new Set(["OWNER", "ADMIN"]);
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  categoryId,
  taskId,
  role,
  currentUserId,
  allTasks,
  onClose,
  onUpdated,
  onDeleted,
}: {
  workspaceId: string;
  projectId: string;
  categoryId: string;
  taskId: string;
  role: string | null;
  currentUserId: string;
  allTasks: Task[];
  onClose: () => void;
  onUpdated: (task: Task) => void;
  onDeleted: (taskId: string) => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conflictTask, setConflictTask] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");

  const [commentDraft, setCommentDraft] = useState("");
  const [mentionMatch, setMentionMatch] = useState<{ start: number; query: string } | null>(null);
  const [postingComment, setPostingComment] = useState(false);
  const [uploading, setUploading] = useState(false);
  const commentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canEdit = role !== null && CAN_EDIT_ROLES.has(role) && !conflictTask;
  const canDelete = role !== null && CAN_DELETE_ROLES.has(role);
  const canManageDependencies = role !== null && CAN_MANAGE_DEPENDENCY_ROLES.has(role);
  const canComment = role !== null && CAN_COMMENT_ROLES.has(role);
  const isElevated = role !== null && ELEVATED_ROLES.has(role);

  const projectBase = `/api/workspaces/${workspaceId}/projects/${projectId}`;
  // Labels remain project-scoped (deliberately separate from Categories —
  // see docs/PHASES.md); every task sub-resource below is category-scoped.
  const base = `${projectBase}/categories/${categoryId}`;

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
      const [taskRes, membersRes, labelsRes, depsRes, commentsRes, attachmentsRes] = await Promise.all([
        api.get<{ task: Task }>(`${base}/tasks/${taskId}`),
        api.get<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspaceId}/members`),
        api.get<{ labels: Label[] }>(`${projectBase}/labels`),
        api.get<{ dependencies: Dependency[] }>(`${base}/tasks/${taskId}/dependencies`),
        api.get<{ comments: Comment[] }>(`${base}/tasks/${taskId}/comments`),
        api.get<{ attachments: Attachment[] }>(`${base}/tasks/${taskId}/attachments`),
      ]);
      applyTask(taskRes.task);
      setMembers(membersRes.members);
      setLabels(labelsRes.labels);
      setDependencies(depsRes.dependencies);
      setComments(commentsRes.comments);
      setAttachments(attachmentsRes.attachments);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this task.");
    }
  }

  // Real-time: live-apply comment/attachment/task events for this specific
  // task while the modal is open, so a collaborator's changes show up
  // without needing to close and reopen it. This only ever reflects events
  // the server already broadcast after persisting a REST mutation.
  useEffect(() => {
    const socket = getSocket();

    const onTaskUpdated = (updated: Task) => {
      if (updated?.id === taskId) applyTask(updated);
    };
    const onCommentCreated = (comment: Comment) => {
      if (comment.taskId !== taskId) return;
      setComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [...prev, comment]));
    };
    const onCommentDeleted = ({ id, taskId: t }: { id: string; taskId: string }) => {
      if (t !== taskId) return;
      setComments((prev) => prev.filter((c) => c.id !== id));
    };
    const onAttachmentCreated = (attachment: Attachment) => {
      if (attachment.taskId !== taskId) return;
      setAttachments((prev) => (prev.some((a) => a.id === attachment.id) ? prev : [attachment, ...prev]));
    };
    const onAttachmentDeleted = ({ id, taskId: t }: { id: string; taskId: string }) => {
      if (t !== taskId) return;
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    };

    socket.on("task.updated", onTaskUpdated);
    socket.on("comment.created", onCommentCreated);
    socket.on("comment.deleted", onCommentDeleted);
    socket.on("attachment.created", onAttachmentCreated);
    socket.on("attachment.deleted", onAttachmentDeleted);
    return () => {
      socket.off("task.updated", onTaskUpdated);
      socket.off("comment.created", onCommentCreated);
      socket.off("comment.deleted", onCommentDeleted);
      socket.off("attachment.created", onAttachmentCreated);
      socket.off("attachment.deleted", onAttachmentDeleted);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

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

  // Mention autocomplete: watches for an "@partial-name" run of characters
  // immediately before the cursor (no whitespace in between) and, if found,
  // shows a dropdown of matching workspace members. Selecting one replaces
  // that run with an opaque `@[userId]` token — see
  // apps/web/src/lib/mentions.ts and packages/shared/src/dto/comment.ts for
  // the full convention.
  function handleCommentDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    const cursor = e.target.selectionStart ?? value.length;
    setCommentDraft(value);

    const uptoCursor = value.slice(0, cursor);
    const match = uptoCursor.match(/(?:^|\s)@([a-zA-Z0-9._' -]{0,30})$/);
    if (match) {
      const query = match[1] ?? "";
      const start = cursor - query.length - 1;
      setMentionMatch({ start, query });
    } else {
      setMentionMatch(null);
    }
  }

  const mentionCandidates = mentionMatch
    ? members
        .filter((m) => m.displayName.toLowerCase().includes(mentionMatch.query.toLowerCase()))
        .slice(0, 5)
    : [];

  function handleSelectMention(member: WorkspaceMember) {
    if (!mentionMatch) return;
    const before = commentDraft.slice(0, mentionMatch.start);
    const after = commentDraft.slice(mentionMatch.start + 1 + mentionMatch.query.length);
    const token = `@[${member.userId}]`;
    const next = `${before}${token} ${after}`;
    setCommentDraft(next);
    setMentionMatch(null);
    commentInputRef.current?.focus();
  }

  async function handlePostComment() {
    const body = commentDraft.trim();
    if (!body) return;
    setPostingComment(true);
    setError(null);
    try {
      const res = await api.post<{ comment: Comment }>(`${base}/tasks/${taskId}/comments`, { body });
      setComments((prev) => (prev.some((c) => c.id === res.comment.id) ? prev : [...prev, res.comment]));
      setCommentDraft("");
      setMentionMatch(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not post this comment.");
    } finally {
      setPostingComment(false);
    }
  }

  async function handleDeleteComment(commentId: string) {
    try {
      await api.delete(`${base}/tasks/${taskId}/comments/${commentId}`);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete this comment.");
    }
  }

  async function handleUploadAttachment(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const res = await api.upload<{ attachment: Attachment }>(`${base}/tasks/${taskId}/attachments`, file);
      setAttachments((prev) => (prev.some((a) => a.id === res.attachment.id) ? prev : [res.attachment, ...prev]));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload this file.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDownloadAttachment(attachment: Attachment) {
    try {
      const blob = await api.download(`${base}/tasks/${taskId}/attachments/${attachment.id}/download`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not download this file.");
    }
  }

  async function handleDeleteAttachment(attachmentId: string) {
    try {
      await api.delete(`${base}/tasks/${taskId}/attachments/${attachmentId}`);
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete this attachment.");
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
            <IconX size={18} />
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
                <span className={`ph-badge ph-badge-priority-${task.priority}`}>{task.priority}</span>
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

        <div className="ph-modal-section">
          <h3>Attachments</h3>
          <ul className="ph-dependency-list">
            {attachments.length === 0 && <li style={{ border: "none" }}>No attachments yet.</li>}
            {attachments.map((a) => (
              <li key={a.id}>
                <span>
                  <button
                    onClick={() => handleDownloadAttachment(a)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "var(--ph-primary, #2563eb)",
                      cursor: "pointer",
                      textDecoration: "underline",
                    }}
                  >
                    {a.filename}
                  </button>{" "}
                  <span style={{ fontSize: "0.75rem", color: "var(--ph-muted)" }}>
                    ({formatBytes(a.sizeBytes)} — uploaded by {a.uploaderDisplayName})
                  </span>
                </span>
                {(a.uploaderId === currentUserId || isElevated) && (
                  <button className="ph-remove-btn" onClick={() => handleDeleteAttachment(a.id)}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canComment && (
            <div style={{ marginTop: "0.5rem" }}>
              <input ref={fileInputRef} type="file" onChange={handleUploadAttachment} disabled={uploading} />
              {uploading && <span style={{ fontSize: "0.8rem", marginLeft: "0.5rem" }}>Uploading...</span>}
            </div>
          )}
        </div>

        <div className="ph-modal-section">
          <h3>Comments</h3>
          <ul className="ph-comment-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {comments.length === 0 && <li style={{ fontSize: "0.85rem" }}>No comments yet.</li>}
            {comments.map((c) => (
              <li
                key={c.id}
                style={{
                  borderBottom: "1px solid var(--ph-border)",
                  padding: "0.5rem 0",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <strong style={{ fontSize: "0.85rem" }}>{c.authorDisplayName}</strong>
                  <span style={{ fontSize: "0.72rem", color: "var(--ph-muted)" }}>{formatDateTime(c.createdAt)}</span>
                </div>
                <p style={{ margin: "0.25rem 0", whiteSpace: "pre-wrap" }}>{renderCommentBody(c.body, members)}</p>
                {(c.authorId === currentUserId || isElevated) && (
                  <button className="ph-remove-btn" onClick={() => handleDeleteComment(c.id)}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>

          {canComment && (
            <div style={{ marginTop: "0.5rem", position: "relative" }}>
              <textarea
                ref={commentInputRef}
                rows={3}
                placeholder="Write a comment... use @ to mention someone"
                value={commentDraft}
                onChange={handleCommentDraftChange}
              />
              {mentionMatch && mentionCandidates.length > 0 && (
                <ul
                  className="ph-card absolute z-10 list-none m-0 p-1 w-[220px] max-w-[calc(100vw-3rem)]"
                >
                  {mentionCandidates.map((m) => (
                    <li key={m.userId}>
                      <button
                        onClick={() => handleSelectMention(m)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          background: "none",
                          border: "none",
                          padding: "0.3rem",
                          cursor: "pointer",
                        }}
                      >
                        {m.displayName}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                className="ph-button ph-button-secondary"
                style={{ width: "auto", marginTop: "0.4rem" }}
                onClick={handlePostComment}
                disabled={postingComment || !commentDraft.trim()}
              >
                {postingComment ? "Posting..." : "Post comment"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
