import { useState, type Dispatch, type SetStateAction } from "react";
import { api, ApiError } from "../lib/api.js";
import type { BulkTaskActionInput } from "../lib/api.js";
import { IconX } from "../components/Icons.js";
import Select from "../components/Select.js";
import type { Task } from "./task-types.js";
import { formatUserName } from "../lib/user-display.js";

type BulkTaskAction = BulkTaskActionInput["action"];

const PRIORITIES: Task["priority"][] = ["low", "medium", "high", "urgent"];

interface ColumnOption {
  id: string;
  name: string;
}

interface WorkspaceMemberOption {
  userId: string;
  displayName: string;
}

interface ProjectLabelOption {
  id: string;
  name: string;
  color: string;
}

interface FailedDetail {
  taskId: string;
  title: string;
  reason: string;
}

interface ResultBanner {
  tone: "warning" | "error";
  headline: string;
  details: FailedDetail[];
}

export interface BulkActionBarProps {
  /** Category-scoped base path, e.g. `/api/workspaces/:w/projects/:p/categories/:c`. */
  base: string;
  tasks: Task[];
  setTasks: Dispatch<SetStateAction<Task[]>>;
  selectedTaskIds: Set<string>;
  setSelectedTaskIds: Dispatch<SetStateAction<Set<string>>>;
  columns: ColumnOption[];
  workspaceMembers: WorkspaceMemberOption[];
  projectLabels: ProjectLabelOption[];
  canEditTasks: boolean;
  canAssignTasks: boolean;
  canDeleteTasks: boolean;
  showToast: (message: string, error?: boolean) => void;
}

function pluralTasks(count: number): string {
  return count === 1 ? "task" : "tasks";
}

function reasonForCode(code: "NOT_IN_CATEGORY" | "VERSION_CONFLICT"): string {
  return code === "VERSION_CONFLICT"
    ? "Someone else changed this task — refresh to retry"
    : "This task is no longer in this category";
}

/**
 * Floating bulk-action bar for the Kanban board (Bulk Task Actions,
 * frontend half — see KanbanBoardPage.tsx for the selection lifecycle this
 * relies on). Deliberately owns only the per-control drafts (which column/
 * priority/user/label is currently chosen in each picker) and the
 * in-flight/result-banner UI state; `tasks`/`selectedTaskIds` themselves
 * stay owned by the parent board so socket events and this bar's own
 * mutations both funnel through the exact same state.
 */
export default function BulkActionBar({
  base,
  tasks,
  setTasks,
  selectedTaskIds,
  setSelectedTaskIds,
  columns,
  workspaceMembers,
  projectLabels,
  canEditTasks,
  canAssignTasks,
  canDeleteTasks,
  showToast,
}: BulkActionBarProps) {
  const [moveColumnId, setMoveColumnId] = useState("");
  const [movePriority, setMovePriority] = useState<Task["priority"]>("medium");
  const [assignUserId, setAssignUserId] = useState("");
  const [unassignUserId, setUnassignUserId] = useState("");
  const [addLabelId, setAddLabelId] = useState("");
  const [removeLabelId, setRemoveLabelId] = useState("");
  const [activeAction, setActiveAction] = useState<BulkTaskAction | null>(null);
  const [resultBanner, setResultBanner] = useState<ResultBanner | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const selectedIds = Array.from(selectedTaskIds);
  // Only ids the board actually still knows about locally — selection is
  // kept pruned to `tasks` by the parent (task.deleted / board refetch /
  // category switch), but this is a cheap extra safety net against ever
  // sending a `versions` map missing an entry for a stale id.
  const presentIds = selectedIds.filter((id) => tasks.some((t) => t.id === id));
  const count = selectedTaskIds.size;

  const unassignOptions = (() => {
    const map = new Map<string, string>();
    for (const t of tasks) {
      if (!selectedTaskIds.has(t.id)) continue;
      for (const a of t.assignees) map.set(a.userId, formatUserName(a.displayName, a.isDeleted));
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  })();

  const removeLabelOptions = (() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const t of tasks) {
      if (!selectedTaskIds.has(t.id)) continue;
      for (const l of t.labels) map.set(l.labelId, { name: l.name, color: l.color });
    }
    return Array.from(map.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
  })();

  function successMessage(action: BulkTaskAction, succeeded: number): string {
    switch (action) {
      case "move": {
        const columnName = columns.find((c) => c.id === moveColumnId)?.name;
        return columnName
          ? `Moved ${succeeded} ${pluralTasks(succeeded)} to ${columnName}.`
          : `Moved ${succeeded} ${pluralTasks(succeeded)}.`;
      }
      case "setPriority":
        return `Updated priority on ${succeeded} ${pluralTasks(succeeded)}.`;
      case "assign":
        return `Assigned ${succeeded} ${pluralTasks(succeeded)}.`;
      case "unassign":
        return `Removed assignee from ${succeeded} ${pluralTasks(succeeded)}.`;
      case "addLabel":
        return `Added label to ${succeeded} ${pluralTasks(succeeded)}.`;
      case "removeLabel":
        return `Removed label from ${succeeded} ${pluralTasks(succeeded)}.`;
      case "delete":
        return `Deleted ${succeeded} ${pluralTasks(succeeded)}.`;
    }
  }

  async function runBulkAction(input: BulkTaskActionInput) {
    if (input.taskIds.length === 0) return;
    setActiveAction(input.action);
    setResultBanner(null);
    try {
      const res = await api.bulkTaskAction(base, input);
      const succeededIds: string[] = [];
      const deletedIds: string[] = [];
      const patchedTasks = new Map<string, Task>();
      const failedDetails: FailedDetail[] = [];

      for (const r of res.results) {
        if (r.status === "success") {
          succeededIds.push(r.taskId);
          if (input.action === "delete") {
            deletedIds.push(r.taskId);
          } else if (r.task) {
            patchedTasks.set(r.taskId, r.task);
          }
        } else {
          const title = tasks.find((t) => t.id === r.taskId)?.title ?? "(unknown task)";
          failedDetails.push({ taskId: r.taskId, title, reason: reasonForCode(r.code) });
          // Refresh the local copy from the conflicting task's current state
          // so a retry uses the up-to-date version instead of looping on the
          // same conflict.
          if (r.code === "VERSION_CONFLICT" && r.currentTask) {
            patchedTasks.set(r.taskId, r.currentTask);
          }
        }
      }

      if (deletedIds.length > 0 || patchedTasks.size > 0) {
        setTasks((prev) =>
          prev.filter((t) => !deletedIds.includes(t.id)).map((t) => patchedTasks.get(t.id) ?? t),
        );
      }

      setSelectedTaskIds((prev) => {
        if (succeededIds.length === 0) return prev;
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });

      const { requested, succeeded, failed } = res.summary;
      if (failed === 0) {
        showToast(successMessage(input.action, succeeded));
        setResultBanner(null);
      } else if (failed === requested) {
        setResultBanner({
          tone: "error",
          headline: `0 of ${requested} ${pluralTasks(requested)} updated — all failed.`,
          details: failedDetails,
        });
      } else {
        setResultBanner({
          tone: "warning",
          headline: `${succeeded} of ${requested} ${pluralTasks(requested)} updated — ${failed} failed.`,
          details: failedDetails,
        });
      }
    } catch (err) {
      // Whole-request failure (422/403/404) — a single toast, selection and
      // any existing result banner left exactly as they were.
      showToast(err instanceof ApiError ? err.message : "Could not complete this bulk action.", true);
    } finally {
      setActiveAction(null);
    }
  }

  function handleMove() {
    if (!moveColumnId || presentIds.length === 0) return;
    const versions: Record<string, number> = {};
    for (const id of presentIds) {
      const t = tasks.find((x) => x.id === id);
      if (t) versions[id] = t.version;
    }
    runBulkAction({ action: "move", taskIds: presentIds, versions, columnId: moveColumnId });
  }

  function handleSetPriority() {
    if (presentIds.length === 0) return;
    const versions: Record<string, number> = {};
    for (const id of presentIds) {
      const t = tasks.find((x) => x.id === id);
      if (t) versions[id] = t.version;
    }
    runBulkAction({ action: "setPriority", taskIds: presentIds, versions, priority: movePriority });
  }

  function handleAssign() {
    if (!assignUserId || presentIds.length === 0) return;
    runBulkAction({ action: "assign", taskIds: presentIds, userId: assignUserId });
  }

  function handleUnassign() {
    if (!unassignUserId || presentIds.length === 0) return;
    runBulkAction({ action: "unassign", taskIds: presentIds, userId: unassignUserId });
  }

  function handleAddLabel() {
    if (!addLabelId || presentIds.length === 0) return;
    runBulkAction({ action: "addLabel", taskIds: presentIds, labelId: addLabelId });
  }

  function handleRemoveLabel() {
    if (!removeLabelId || presentIds.length === 0) return;
    runBulkAction({ action: "removeLabel", taskIds: presentIds, labelId: removeLabelId });
  }

  function handleDelete() {
    if (presentIds.length === 0) return;
    if (!confirm(`Delete ${presentIds.length} selected ${pluralTasks(presentIds.length)}? This cannot be undone.`)) {
      return;
    }
    runBulkAction({ action: "delete", taskIds: presentIds });
  }

  function handleClearSelection() {
    setSelectedTaskIds(new Set());
  }

  const busy = activeAction !== null;

  if (count === 0) return null;

  return (
    <div className="ph-bulk-bar-stack">
      {resultBanner && (
        <div
          className={`ph-bulk-result-banner${resultBanner.tone === "error" ? " ph-bulk-result-banner-error" : ""}`}
        >
          <div className="ph-bulk-result-banner-header">
            <span>{resultBanner.headline}</span>
            {resultBanner.details.length > 0 && (
              <button
                type="button"
                className="ph-column-history-toggle"
                onClick={() => setDetailsOpen((v) => !v)}
              >
                {detailsOpen ? "Hide details" : "View details"}
              </button>
            )}
          </div>
          {detailsOpen && resultBanner.details.length > 0 && (
            <ul className="ph-bulk-result-list">
              {resultBanner.details.map((d) => (
                <li key={d.taskId} className="ph-bulk-result-item">
                  <span className="ph-bulk-result-item-title">{d.title}</span>
                  <span className="ph-bulk-result-item-reason">{d.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="ph-bulk-bar">
        <span className="ph-bulk-bar-count">{count} selected</span>

        {canEditTasks && (
          <>
            <span className="ph-bulk-bar-divider" aria-hidden="true" />
            <div className="ph-bulk-bar-group">
              <Select
                aria-label="Move selected tasks to column"
                value={moveColumnId}
                disabled={busy}
                onChange={setMoveColumnId}
                options={[
                  { value: "", label: "Move to..." },
                  ...columns.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
              <button
                type="button"
                className="ph-button ph-button-secondary"
                style={{ width: "auto" }}
                disabled={busy || !moveColumnId}
                onClick={handleMove}
              >
                {activeAction === "move" ? "Moving..." : "Move"}
              </button>
            </div>

            <span className="ph-bulk-bar-divider" aria-hidden="true" />
            <div className="ph-bulk-bar-group">
              <Select
                aria-label="Set priority for selected tasks"
                value={movePriority}
                disabled={busy}
                onChange={(v) => setMovePriority(v as Task["priority"])}
                options={PRIORITIES.map((p) => ({ value: p, label: p }))}
              />
              <button
                type="button"
                className="ph-button ph-button-secondary"
                style={{ width: "auto" }}
                disabled={busy}
                onClick={handleSetPriority}
              >
                {activeAction === "setPriority" ? "Updating..." : "Set priority"}
              </button>
            </div>

            <span className="ph-bulk-bar-divider" aria-hidden="true" />
            <div className="ph-bulk-bar-group">
              <Select
                aria-label="Add label to selected tasks"
                value={addLabelId}
                disabled={busy}
                onChange={setAddLabelId}
                options={[
                  { value: "", label: "Add label..." },
                  ...projectLabels.map((l) => ({ value: l.id, label: l.name })),
                ]}
              />
              <button
                type="button"
                className="ph-button ph-button-secondary"
                style={{ width: "auto" }}
                disabled={busy || !addLabelId}
                onClick={handleAddLabel}
              >
                {activeAction === "addLabel" ? "Adding..." : "Add label"}
              </button>
            </div>

            {removeLabelOptions.length > 0 && (
              <div className="ph-bulk-bar-group">
                <Select
                  aria-label="Remove label from selected tasks"
                  value={removeLabelId}
                  disabled={busy}
                  onChange={setRemoveLabelId}
                  options={[
                    { value: "", label: "Remove label..." },
                    ...removeLabelOptions.map(([id, l]) => ({ value: id, label: l.name })),
                  ]}
                />
                <button
                  type="button"
                  className="ph-button ph-button-secondary"
                  style={{ width: "auto" }}
                  disabled={busy || !removeLabelId}
                  onClick={handleRemoveLabel}
                >
                  {activeAction === "removeLabel" ? "Removing..." : "Remove label"}
                </button>
              </div>
            )}
          </>
        )}

        {canAssignTasks && (
          <>
            <span className="ph-bulk-bar-divider" aria-hidden="true" />
            <div className="ph-bulk-bar-group">
              <Select
                aria-label="Assign selected tasks"
                value={assignUserId}
                disabled={busy}
                onChange={setAssignUserId}
                options={[
                  { value: "", label: "Assign to..." },
                  ...workspaceMembers.map((m) => ({ value: m.userId, label: m.displayName })),
                ]}
              />
              <button
                type="button"
                className="ph-button ph-button-secondary"
                style={{ width: "auto" }}
                disabled={busy || !assignUserId}
                onClick={handleAssign}
              >
                {activeAction === "assign" ? "Assigning..." : "Assign"}
              </button>
            </div>

            {unassignOptions.length > 0 && (
              <div className="ph-bulk-bar-group">
                <Select
                  aria-label="Remove assignee from selected tasks"
                  value={unassignUserId}
                  disabled={busy}
                  onChange={setUnassignUserId}
                  options={[
                    { value: "", label: "Remove assignee..." },
                    ...unassignOptions.map(([id, displayName]) => ({ value: id, label: displayName })),
                  ]}
                />
                <button
                  type="button"
                  className="ph-button ph-button-secondary"
                  style={{ width: "auto" }}
                  disabled={busy || !unassignUserId}
                  onClick={handleUnassign}
                >
                  {activeAction === "unassign" ? "Removing..." : "Remove"}
                </button>
              </div>
            )}
          </>
        )}

        {canDeleteTasks && (
          <>
            <span className="ph-bulk-bar-divider" aria-hidden="true" />
            <button
              type="button"
              className="ph-button ph-button-secondary"
              style={{ width: "auto", borderColor: "var(--ph-error)", color: "var(--ph-error)" }}
              disabled={busy}
              onClick={handleDelete}
            >
              {activeAction === "delete" ? "Deleting..." : "Delete"}
            </button>
          </>
        )}

        <button
          type="button"
          className="ph-bulk-bar-clear"
          disabled={busy}
          onClick={handleClearSelection}
        >
          <IconX size={14} />
          Clear selection
        </button>
      </div>
    </div>
  );
}
