import { useEffect, useRef, useState } from "react";
import type { CustomFieldType, RecurrenceFrequency, RecurrenceRule } from "@projecthub/shared";
import { RECURRENCE_FREQUENCIES } from "@projecthub/shared";
import { api, ApiError } from "../lib/api.js";
import { getSocket } from "../lib/socket.js";
import { renderCommentBody } from "../lib/mentions.js";
import { formatUserName } from "../lib/user-display.js";
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

// Project-scoped field definitions (see ProjectCustomFieldsPanel.tsx and
// apps/api/src/projects/custom-fields.routes.ts) — every project member sees
// this section (read-only if `!canEdit`), definitions come from the SAME
// base as `labelsRes` below (project-scoped), values come from the
// category-scoped `base` used by every other task sub-resource in this file.
interface CustomFieldDefinition {
  id: string;
  projectId: string;
  name: string;
  type: CustomFieldType;
  options: string[];
  position: number;
  createdAt: string;
  updatedAt: string;
}

interface CustomFieldValue {
  taskId: string;
  fieldId: string;
  value: unknown;
  // True when this field's `options` changed after the value was set and the
  // stored value no longer matches the current options (e.g. a renamed
  // select option) — the UI must flag this rather than render it silently.
  stale: boolean;
  updatedAt: string;
}

// select/multi_select's `value` is validated against the field's `options`;
// every other type has no such closed vocabulary.
const OPTIONS_BASED_TYPES = new Set<CustomFieldType>(["select", "multi_select"]);

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

// "Make recurring" section: singular/plural unit words for the summary
// sentence and the "Repeats every [N] [unit]" form row.
const RECURRENCE_UNIT_LABELS: Record<RecurrenceFrequency, { singular: string; plural: string }> = {
  daily: { singular: "day", plural: "days" },
  weekly: { singular: "week", plural: "weeks" },
  monthly: { singular: "month", plural: "months" },
};

/** Plain YYYY-MM-DD formatting for an ISO timestamp — deliberately never
 * `toLocaleDateString`, so the summary sentence reads the same regardless
 * of the viewer's locale. */
function formatIsoDatePlain(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Builds the "Repeats every ... [until DATE | N occurrences remaining]."
 * summary sentence shown both in the read-only view and above the prefilled
 * form. `spawnedSoFar` is the task's own `recurrenceCount` (how many
 * occurrences have already been spawned), used to compute how many remain
 * for a count-bounded recurrence.
 */
function formatRecurrenceSummary(rule: RecurrenceRule, spawnedSoFar: number): string {
  const unit = RECURRENCE_UNIT_LABELS[rule.freq];
  const base = rule.interval === 1 ? `Repeats every ${unit.singular}` : `Repeats every ${rule.interval} ${unit.plural}`;

  if (rule.until != null) {
    return `${base} until ${formatIsoDatePlain(rule.until)}.`;
  }
  if (rule.count != null) {
    const remaining = rule.count - spawnedSoFar;
    if (remaining > 1) return `${base}. ${remaining} occurrences remaining.`;
    if (remaining === 1) return `${base}. 1 occurrence remaining.`;
    return `${base}. — no occurrences remaining.`;
  }
  return `${base}.`;
}

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
  onOpenTask,
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
  onOpenTask?: (taskId: string) => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<CustomFieldValue[]>([]);
  // Draft strings for the free-text-ish types (text/number/date/url), keyed
  // by fieldId — these are edited locally and only sent on an explicit Save,
  // unlike select/multi_select/checkbox which PUT immediately on change
  // (mirroring handleToggleLabel's immediate-save pattern below). Re-seeded
  // from the server any time the values list is (re)loaded, same convention
  // as applyTask re-seeding `title`/`description` etc. on every task load.
  const [customFieldDrafts, setCustomFieldDrafts] = useState<Record<string, string>>({});
  const [customFieldErrors, setCustomFieldErrors] = useState<Record<string, string>>({});
  const [customFieldSaving, setCustomFieldSaving] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflictTask, setConflictTask] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");

  // "Make recurring" section drafts — re-seeded from `task.recurrenceRule`
  // inside applyTask, same "reload wins" convention as title/description/etc.
  // above (recurrence is a compound, independently-persisted rule, but it
  // lives on the task itself, not a separate sub-resource like custom
  // fields, so it's seeded directly in applyTask rather than a sibling
  // function).
  const [recurrenceFreq, setRecurrenceFreq] = useState<RecurrenceFrequency>("weekly");
  const [recurrenceInterval, setRecurrenceInterval] = useState("1");
  const [recurrenceEndMode, setRecurrenceEndMode] = useState<"never" | "onDate" | "afterCount">("never");
  const [recurrenceUntil, setRecurrenceUntil] = useState("");
  const [recurrenceCountDraft, setRecurrenceCountDraft] = useState("1");
  const [recurrenceSaving, setRecurrenceSaving] = useState(false);
  const [recurrenceError, setRecurrenceError] = useState<string | null>(null);

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

    const rule = t.recurrenceRule;
    setRecurrenceFreq(rule?.freq ?? "weekly");
    setRecurrenceInterval(rule ? String(rule.interval) : "1");
    if (rule?.until) {
      setRecurrenceEndMode("onDate");
      setRecurrenceUntil(formatDateInput(rule.until));
    } else if (rule?.count != null) {
      setRecurrenceEndMode("afterCount");
      setRecurrenceCountDraft(String(rule.count));
    } else {
      setRecurrenceEndMode("never");
      setRecurrenceUntil("");
      setRecurrenceCountDraft("1");
    }
    setRecurrenceError(null);
  }

  // Re-seeds the text/number/date/url drafts from whatever the server just
  // returned. Called after the initial load and after every custom-field
  // value mutation, so a field's draft always starts back in sync with the
  // committed value (same "reload wins" convention as applyTask above).
  function applyCustomFieldValues(values: CustomFieldValue[], fields: CustomFieldDefinition[]) {
    setCustomFieldValues(values);
    const nextDrafts: Record<string, string> = {};
    for (const field of fields) {
      if (OPTIONS_BASED_TYPES.has(field.type) || field.type === "checkbox") continue;
      const existing = values.find((v) => v.fieldId === field.id);
      nextDrafts[field.id] = existing !== undefined ? String(existing.value) : "";
    }
    setCustomFieldDrafts(nextDrafts);
  }

  async function refreshCustomFieldValues() {
    const res = await api.get<{ values: CustomFieldValue[] }>(`${base}/tasks/${taskId}/custom-fields`);
    applyCustomFieldValues(res.values, customFields);
  }

  async function load() {
    try {
      const [taskRes, membersRes, labelsRes, depsRes, commentsRes, attachmentsRes, customFieldsRes, customFieldValuesRes] =
        await Promise.all([
          api.get<{ task: Task }>(`${base}/tasks/${taskId}`),
          api.get<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspaceId}/members`),
          api.get<{ labels: Label[] }>(`${projectBase}/labels`),
          api.get<{ dependencies: Dependency[] }>(`${base}/tasks/${taskId}/dependencies`),
          api.get<{ comments: Comment[] }>(`${base}/tasks/${taskId}/comments`),
          api.get<{ attachments: Attachment[] }>(`${base}/tasks/${taskId}/attachments`),
          api.get<{ fields: CustomFieldDefinition[] }>(`${projectBase}/custom-fields`),
          api.get<{ values: CustomFieldValue[] }>(`${base}/tasks/${taskId}/custom-fields`),
        ]);
      applyTask(taskRes.task);
      setMembers(membersRes.members);
      setLabels(labelsRes.labels);
      setDependencies(depsRes.dependencies);
      setComments(commentsRes.comments);
      setAttachments(attachmentsRes.attachments);
      const sortedFields = customFieldsRes.fields.slice().sort((a, b) => a.position - b.position);
      setCustomFields(sortedFields);
      applyCustomFieldValues(customFieldValuesRes.values, sortedFields);
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

  // Checkbox affordance for the same completion toggle available on the
  // compact board card — wired to the identical PATCH call and the same
  // version-conflict handling as handleSave, since this is just another
  // task-edit field, not a separate action.
  async function handleToggleCompleted() {
    if (!task) return;
    setError(null);
    try {
      const res = await api.patch<{ task: Task }>(`${base}/tasks/${taskId}`, {
        version: task.version,
        completed: !task.completedAt,
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
        setError(err instanceof ApiError ? err.message : "Could not update this task's completion state.");
      }
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

  // "Make recurring" section — a compound, independently-persisted rule
  // (like Custom Fields), so it's validated and saved on its own explicit
  // Save action, never bundled into handleSave's title/description/etc.
  // PATCH. Mirrors handleSave's exact call/response-handling shape,
  // including 409/version-conflict handling, but keeps its own LOCAL error
  // banner (recurrenceError) rather than the modal's shared `error` state.
  async function handleSaveRecurrence() {
    if (!task) return;
    setRecurrenceError(null);

    if (!recurrenceInterval.trim()) {
      setRecurrenceError("Enter how often this task should repeat.");
      return;
    }
    const interval = Number(recurrenceInterval);
    if (!Number.isInteger(interval) || interval < 1) {
      setRecurrenceError("Enter a whole number of 1 or more.");
      return;
    }
    if (recurrenceEndMode === "onDate") {
      if (!recurrenceUntil) {
        setRecurrenceError("Choose an end date, or pick a different ending option.");
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      if (recurrenceUntil < today) {
        setRecurrenceError("Choose an end date that is today or later.");
        return;
      }
    }
    if (recurrenceEndMode === "afterCount") {
      const count = Number(recurrenceCountDraft);
      if (!recurrenceCountDraft.trim() || !Number.isInteger(count) || count < 1) {
        setRecurrenceError("Enter 1 or more occurrences.");
        return;
      }
    }

    setRecurrenceSaving(true);
    try {
      // ANY write of a non-null rule (brand new or edited) resets
      // nextRunAt/recurrenceCount server-side — there is no "adjust in
      // place" concept in v1 — so starting a fresh `startAt = now()` on
      // every save is correct, not just simplest.
      const payload = {
        freq: recurrenceFreq,
        interval,
        startAt: new Date().toISOString(),
        until: recurrenceEndMode === "onDate" ? new Date(recurrenceUntil).toISOString() : null,
        count: recurrenceEndMode === "afterCount" ? Number(recurrenceCountDraft) : null,
      };
      const res = await api.patch<{ task: Task }>(`${base}/tasks/${taskId}`, {
        version: task.version,
        recurrenceRule: payload,
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
        setRecurrenceError(err instanceof ApiError ? err.message : "Could not save this recurrence rule.");
      }
    } finally {
      setRecurrenceSaving(false);
    }
  }

  async function handleRemoveRecurrence() {
    if (!task) return;
    if (
      !confirm(
        "Stop this task from repeating? This won't affect instances that were already created — only future ones will no longer be generated.",
      )
    ) {
      return;
    }
    setRecurrenceSaving(true);
    setRecurrenceError(null);
    try {
      const res = await api.patch<{ task: Task }>(`${base}/tasks/${taskId}`, {
        version: task.version,
        recurrenceRule: null,
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
        setRecurrenceError(err instanceof ApiError ? err.message : "Could not save this recurrence rule.");
      }
    } finally {
      setRecurrenceSaving(false);
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

  function getCustomFieldValue(fieldId: string): CustomFieldValue | undefined {
    return customFieldValues.find((v) => v.fieldId === fieldId);
  }

  // Shared PUT path for every custom-field type — `value` must already be
  // the type-appropriate JSON shape (string/number/boolean/string[]) the
  // caller built; per-type validation happens server-side, so a 422 here
  // just surfaces the server's own message rather than being replicated
  // client-side. Always refetches the values list afterward (proportionate
  // refetch of just this sub-resource, matching handleRemoveDependency
  // above, rather than reloading the whole task).
  async function handleSetCustomFieldValue(field: CustomFieldDefinition, value: unknown) {
    setCustomFieldErrors((prev) => ({ ...prev, [field.id]: "" }));
    setCustomFieldSaving((prev) => ({ ...prev, [field.id]: true }));
    try {
      await api.put(`${base}/tasks/${taskId}/custom-fields/${field.id}`, { value });
      await refreshCustomFieldValues();
    } catch (err) {
      setCustomFieldErrors((prev) => ({
        ...prev,
        [field.id]: err instanceof ApiError ? err.message : `Could not save "${field.name}".`,
      }));
    } finally {
      setCustomFieldSaving((prev) => ({ ...prev, [field.id]: false }));
    }
  }

  async function handleClearCustomFieldValue(field: CustomFieldDefinition) {
    setCustomFieldErrors((prev) => ({ ...prev, [field.id]: "" }));
    setCustomFieldSaving((prev) => ({ ...prev, [field.id]: true }));
    try {
      await api.delete(`${base}/tasks/${taskId}/custom-fields/${field.id}`);
      await refreshCustomFieldValues();
    } catch (err) {
      setCustomFieldErrors((prev) => ({
        ...prev,
        [field.id]: err instanceof ApiError ? err.message : `Could not clear "${field.name}".`,
      }));
    } finally {
      setCustomFieldSaving((prev) => ({ ...prev, [field.id]: false }));
    }
  }

  // text/number/date/url all share this "clear when the draft is emptied,
  // otherwise PUT the trimmed draft" shape — a PUT with an empty string is
  // always a 422 server-side (both text and url reject it), so an emptied
  // draft must route to DELETE, and only when a value is currently set
  // (otherwise it's a no-op, avoiding a pointless 404 DELETE call).
  function handleSaveTextField(field: CustomFieldDefinition) {
    const draft = (customFieldDrafts[field.id] ?? "").trim();
    if (!draft) {
      if (getCustomFieldValue(field.id)) void handleClearCustomFieldValue(field);
      return;
    }
    void handleSetCustomFieldValue(field, draft);
  }

  function handleSaveNumberField(field: CustomFieldDefinition) {
    const draft = (customFieldDrafts[field.id] ?? "").trim();
    if (!draft) {
      if (getCustomFieldValue(field.id)) void handleClearCustomFieldValue(field);
      return;
    }
    const num = Number(draft);
    if (!Number.isFinite(num)) {
      setCustomFieldErrors((prev) => ({ ...prev, [field.id]: "Enter a valid number." }));
      return;
    }
    void handleSetCustomFieldValue(field, num);
  }

  function handleSaveDateField(field: CustomFieldDefinition) {
    // The raw <input type="date"> value is already YYYY-MM-DD — unlike the
    // fixed startDate/dueDate fields elsewhere in this file, this must NOT
    // be run through `new Date(...).toISOString()`; custom-field date values
    // are plain date strings, not ISO datetimes (see buildCustomFieldValueSchema).
    const draft = customFieldDrafts[field.id] ?? "";
    if (!draft) {
      if (getCustomFieldValue(field.id)) void handleClearCustomFieldValue(field);
      return;
    }
    void handleSetCustomFieldValue(field, draft);
  }

  function handleSaveUrlField(field: CustomFieldDefinition) {
    const draft = (customFieldDrafts[field.id] ?? "").trim();
    if (!draft) {
      if (getCustomFieldValue(field.id)) void handleClearCustomFieldValue(field);
      return;
    }
    // Lightweight pre-check only (native `type="url"` validation is looser
    // than the server's http(s)-only check) — the server's own message is
    // still surfaced on a 422 either way, this just avoids an obviously
    // doomed round-trip for a non-URL string.
    try {
      const parsed = new URL(draft);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setCustomFieldErrors((prev) => ({ ...prev, [field.id]: "Value must be a valid http(s) URL." }));
        return;
      }
    } catch {
      setCustomFieldErrors((prev) => ({ ...prev, [field.id]: "Value must be a valid http(s) URL." }));
      return;
    }
    void handleSetCustomFieldValue(field, draft);
  }

  function handleSelectFieldChange(field: CustomFieldDefinition, nextValue: string) {
    if (!nextValue) {
      if (getCustomFieldValue(field.id)) void handleClearCustomFieldValue(field);
      return;
    }
    void handleSetCustomFieldValue(field, nextValue);
  }

  function handleToggleMultiSelectOption(field: CustomFieldDefinition, option: string) {
    const existing = getCustomFieldValue(field.id);
    const current = Array.isArray(existing?.value) ? (existing.value as unknown[]).map(String) : [];
    const next = current.includes(option) ? current.filter((o) => o !== option) : [...current, option];
    if (next.length === 0) {
      // A multi_select value must have at least one option — clearing the
      // last remaining chip must DELETE, never PUT an empty array (rejected
      // 422 server-side).
      void handleClearCustomFieldValue(field);
    } else {
      void handleSetCustomFieldValue(field, next);
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

  // Plain-text rendering for the read-only (!canEdit) path and as a general
  // "what's actually stored" fallback — deliberately still renders a stale
  // select/multi_select value's raw stored string(s) rather than hiding it,
  // per the stale-badge requirement ("still show what's stored, just
  // visibly flagged").
  function formatCustomFieldValue(field: CustomFieldDefinition, valueEntry: CustomFieldValue | undefined): string {
    if (!valueEntry) return "Not set";
    const value = valueEntry.value;
    if (field.type === "checkbox") return value ? "Yes" : "No";
    if (field.type === "multi_select") {
      return Array.isArray(value) && value.length > 0 ? value.map(String).join(", ") : "Not set";
    }
    return String(value);
  }

  function renderCustomFieldControl(field: CustomFieldDefinition) {
    const valueEntry = getCustomFieldValue(field.id);
    const hasValue = valueEntry !== undefined;
    const isSaving = Boolean(customFieldSaving[field.id]);

    if (!canEdit) {
      return <p style={{ margin: 0, fontSize: "0.85rem" }}>{formatCustomFieldValue(field, valueEntry)}</p>;
    }

    const clearButton = hasValue && (
      <button
        type="button"
        className="ph-remove-btn"
        disabled={isSaving}
        onClick={() => handleClearCustomFieldValue(field)}
      >
        Clear
      </button>
    );

    switch (field.type) {
      case "text":
        return (
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <input
              value={customFieldDrafts[field.id] ?? ""}
              onChange={(e) => setCustomFieldDrafts((prev) => ({ ...prev, [field.id]: e.target.value }))}
              placeholder="Not set"
              maxLength={1000}
              aria-label={field.name}
            />
            <button
              type="button"
              className="ph-button ph-button-secondary"
              style={{ width: "auto" }}
              disabled={isSaving}
              onClick={() => handleSaveTextField(field)}
            >
              Save
            </button>
            {clearButton}
          </div>
        );

      case "number":
        return (
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <input
              type="number"
              value={customFieldDrafts[field.id] ?? ""}
              onChange={(e) => setCustomFieldDrafts((prev) => ({ ...prev, [field.id]: e.target.value }))}
              placeholder="Not set"
              aria-label={field.name}
            />
            <button
              type="button"
              className="ph-button ph-button-secondary"
              style={{ width: "auto" }}
              disabled={isSaving}
              onClick={() => handleSaveNumberField(field)}
            >
              Save
            </button>
            {clearButton}
          </div>
        );

      case "date":
        return (
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <input
              type="date"
              value={customFieldDrafts[field.id] ?? ""}
              onChange={(e) => setCustomFieldDrafts((prev) => ({ ...prev, [field.id]: e.target.value }))}
              aria-label={field.name}
            />
            <button
              type="button"
              className="ph-button ph-button-secondary"
              style={{ width: "auto" }}
              disabled={isSaving}
              onClick={() => handleSaveDateField(field)}
            >
              Save
            </button>
            {clearButton}
          </div>
        );

      case "url":
        return (
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <input
              type="url"
              value={customFieldDrafts[field.id] ?? ""}
              onChange={(e) => setCustomFieldDrafts((prev) => ({ ...prev, [field.id]: e.target.value }))}
              placeholder="https://..."
              maxLength={2048}
              aria-label={field.name}
            />
            <button
              type="button"
              className="ph-button ph-button-secondary"
              style={{ width: "auto" }}
              disabled={isSaving}
              onClick={() => handleSaveUrlField(field)}
            >
              Save
            </button>
            {clearButton}
          </div>
        );

      case "select": {
        const currentValue = typeof valueEntry?.value === "string" ? valueEntry.value : "";
        const isStaleValue = currentValue !== "" && !field.options.includes(currentValue);
        return (
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
            <select
              value={currentValue}
              disabled={isSaving}
              aria-label={field.name}
              onChange={(e) => handleSelectFieldChange(field, e.target.value)}
            >
              <option value="">Not set</option>
              {isStaleValue && (
                <option value={currentValue} disabled>
                  {currentValue} (no longer a valid option)
                </option>
              )}
              {field.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            {clearButton}
          </div>
        );
      }

      case "multi_select": {
        const current = Array.isArray(valueEntry?.value) ? (valueEntry.value as unknown[]).map(String) : [];
        const invalidSelected = current.filter((v) => !field.options.includes(v));
        return (
          <div>
            <div className="ph-task-card-meta">
              {field.options.map((opt) => {
                const attached = current.includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    className="ph-label-chip"
                    style={{
                      background: attached ? "var(--ph-primary)" : "transparent",
                      color: attached ? "white" : "var(--ph-text)",
                      border: "1px solid var(--ph-border)",
                      cursor: isSaving ? "default" : "pointer",
                    }}
                    disabled={isSaving}
                    onClick={() => handleToggleMultiSelectOption(field, opt)}
                  >
                    {opt}
                  </button>
                );
              })}
              {invalidSelected.map((opt) => (
                <span
                  key={opt}
                  className="ph-label-chip"
                  style={{ border: "1px dashed var(--ph-error)", color: "var(--ph-error)", opacity: 0.8 }}
                  title="No longer a valid option for this field"
                >
                  {opt} (invalid)
                </span>
              ))}
              {field.options.length === 0 && invalidSelected.length === 0 && (
                <span style={{ fontSize: "0.85rem" }}>No options defined.</span>
              )}
            </div>
            {clearButton}
          </div>
        );
      }

      case "checkbox":
        return (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input
              type="checkbox"
              checked={Boolean(valueEntry?.value)}
              disabled={isSaving}
              aria-label={field.name}
              onChange={(e) => handleSetCustomFieldValue(field, e.target.checked)}
            />
            <span style={{ fontSize: "0.85rem" }}>{valueEntry?.value ? "Yes" : "No"}</span>
            {clearButton}
          </div>
        );

      default:
        return null;
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

        {task.recurrenceTemplateId &&
          (task.recurrenceTemplateTitle !== null ? (
            <button
              type="button"
              className="ph-badge ph-badge-recurring-instance"
              style={{
                maxWidth: 320,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "block",
                marginBottom: "0.5rem",
              }}
              title={`This task was automatically created from the recurring task "${task.recurrenceTemplateTitle}". Click to open it.`}
              onClick={() => onOpenTask?.(task.recurrenceTemplateId!)}
            >
              Spawned from &quot;{task.recurrenceTemplateTitle}&quot;
            </button>
          ) : (
            <span
              className="ph-badge ph-badge-recurring-instance"
              style={{
                maxWidth: 320,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "block",
                marginBottom: "0.5rem",
              }}
            >
              Spawned from a recurring task
            </span>
          ))}

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

        <label className="ph-task-complete-toggle">
          <input
            type="checkbox"
            checked={Boolean(task.completedAt)}
            disabled={!canEdit}
            onChange={handleToggleCompleted}
            aria-label={task.completedAt ? "Mark task as not done" : "Mark task as done"}
          />
          {task.completedAt ? (
            <span>Completed on {formatDateTime(task.completedAt)}</span>
          ) : (
            <span>Mark as done</span>
          )}
        </label>

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
                    <span>{formatUserName(a.displayName, a.isDeleted)}</span>
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
          <h3>Make recurring</h3>
          {(() => {
            const isInstance = task.recurrenceTemplateId !== null;
            const isSubtask = task.parentTaskId !== null;
            const hasRule = task.recurrenceRule !== null;

            if (isInstance) {
              return <p style={{ margin: 0, fontSize: "0.85rem" }}>Tasks created by a recurring task can't themselves be made recurring.</p>;
            }
            if (isSubtask) {
              return <p style={{ margin: 0, fontSize: "0.85rem" }}>Subtasks can't be made recurring.</p>;
            }

            if (!canEdit) {
              return (
                <p style={{ margin: 0, fontSize: "0.85rem" }}>
                  {hasRule ? formatRecurrenceSummary(task.recurrenceRule!, task.recurrenceCount) : "This task doesn't repeat."}
                </p>
              );
            }

            return (
              <div>
                {hasRule && (
                  <p style={{ fontWeight: 600, marginTop: 0 }}>
                    {formatRecurrenceSummary(task.recurrenceRule!, task.recurrenceCount)}
                  </p>
                )}
                {!hasRule && (
                  <p style={{ fontSize: "0.85rem", color: "var(--ph-muted)" }}>
                    Choose how often this task repeats and, optionally, when it should stop. A new copy of this task
                    will be created automatically each time it's due.
                  </p>
                )}

                {recurrenceError && <div className="ph-alert ph-alert-error">{recurrenceError}</div>}

                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                  <label htmlFor="ph-recurrence-interval">Repeats every</label>
                  <input
                    id="ph-recurrence-interval"
                    type="number"
                    min={1}
                    max={99}
                    style={{ width: "5rem" }}
                    value={recurrenceInterval}
                    onChange={(e) => setRecurrenceInterval(e.target.value)}
                  />
                  <select
                    aria-label="Recurrence frequency"
                    value={recurrenceFreq}
                    onChange={(e) => setRecurrenceFreq(e.target.value as RecurrenceFrequency)}
                  >
                    {RECURRENCE_FREQUENCIES.map((freq) => (
                      <option key={freq} value={freq}>
                        {RECURRENCE_UNIT_LABELS[freq].singular}(s)
                      </option>
                    ))}
                  </select>
                </div>

                <fieldset style={{ border: "1px solid var(--ph-border)", borderRadius: "0.4rem", padding: "0.6rem", marginBottom: "0.75rem" }}>
                  <legend style={{ fontSize: "0.85rem" }}>Ends</legend>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <input
                        type="radio"
                        name="recurrence-end-mode"
                        checked={recurrenceEndMode === "never"}
                        onChange={() => setRecurrenceEndMode("never")}
                      />
                      Never
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <input
                        type="radio"
                        name="recurrence-end-mode"
                        checked={recurrenceEndMode === "onDate"}
                        onChange={() => setRecurrenceEndMode("onDate")}
                      />
                      On
                      <input
                        type="date"
                        disabled={recurrenceEndMode !== "onDate"}
                        value={recurrenceUntil}
                        onChange={(e) => setRecurrenceUntil(e.target.value)}
                      />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <input
                        type="radio"
                        name="recurrence-end-mode"
                        checked={recurrenceEndMode === "afterCount"}
                        onChange={() => setRecurrenceEndMode("afterCount")}
                      />
                      After
                      <input
                        type="number"
                        min={1}
                        style={{ width: "5rem" }}
                        disabled={recurrenceEndMode !== "afterCount"}
                        value={recurrenceCountDraft}
                        onChange={(e) => setRecurrenceCountDraft(e.target.value)}
                      />
                      occurrence(s)
                    </label>
                  </div>
                </fieldset>

                <button
                  className="ph-button"
                  style={{ width: "auto" }}
                  disabled={recurrenceSaving}
                  onClick={handleSaveRecurrence}
                >
                  {recurrenceSaving ? "Saving..." : hasRule ? "Save recurrence" : "Start recurring"}
                </button>
                {hasRule && (
                  <button
                    className="ph-button ph-button-secondary"
                    style={{
                      width: "auto",
                      marginLeft: "0.6rem",
                      borderColor: "var(--ph-error)",
                      color: "var(--ph-error)",
                    }}
                    disabled={recurrenceSaving}
                    onClick={handleRemoveRecurrence}
                  >
                    Remove recurrence
                  </button>
                )}
              </div>
            );
          })()}
        </div>

        <div className="ph-modal-section">
          <h3>Custom fields</h3>
          {customFields.length === 0 ? (
            <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--ph-muted)" }}>
              No custom fields defined for this project.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
              {customFields.map((field) => {
                const valueEntry = getCustomFieldValue(field.id);
                const fieldError = customFieldErrors[field.id];
                return (
                  <div key={field.id} className="ph-field">
                    <label>
                      {field.name}
                      {valueEntry?.stale && (
                        <span
                          className="ph-badge ph-badge-stale"
                          style={{ marginLeft: "0.5rem" }}
                          title="This field's options changed since this value was set — the stored value may no longer be valid."
                        >
                          Outdated value
                        </span>
                      )}
                    </label>
                    {fieldError && (
                      <div className="ph-alert ph-alert-error" style={{ margin: "0.25rem 0" }}>
                        {fieldError}
                      </div>
                    )}
                    {renderCustomFieldControl(field)}
                  </div>
                );
              })}
            </div>
          )}
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
                    ({formatBytes(a.sizeBytes)} — uploaded by {formatUserName(a.uploaderDisplayName, a.uploaderIsDeleted)})
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
                  <strong style={{ fontSize: "0.85rem" }}>{formatUserName(c.authorDisplayName, c.authorIsDeleted)}</strong>
                  <span style={{ fontSize: "0.72rem", color: "var(--ph-muted)" }}>{formatDateTime(c.createdAt)}</span>
                </div>
                <p style={{ margin: "0.25rem 0", whiteSpace: "pre-wrap" }}>{renderCommentBody(c.body, members, c.mentions)}</p>
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
