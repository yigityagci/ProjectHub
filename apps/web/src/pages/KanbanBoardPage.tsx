import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  DndContext,
  closestCorners,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import {
  getSocket,
  joinWorkspaceRoom,
  joinProjectRoom,
  leaveProjectRoom,
  joinCategoryRoom,
  leaveCategoryRoom,
} from "../lib/socket.js";
import NotificationBell from "../components/NotificationBell.js";
import ThemeToggle from "../components/ThemeToggle.js";
import SettingsGearLink from "../components/SettingsGearLink.js";
import ActivityFeed from "../components/ActivityFeed.js";
import { IconGrip, IconPencil, IconPlus, IconTrash } from "../components/Icons.js";
import { getStoredDefaultBoardView } from "../lib/personalization.js";
import { formatUserName } from "../lib/user-display.js";
import TaskDetailModal from "./TaskDetailModal.js";
import CreateTaskModal from "./CreateTaskModal.js";
import BulkActionBar from "./BulkActionBar.js";
import type { CurrentUser } from "../App.js";
import type { Task } from "./task-types.js";

interface ProjectLabel {
  id: string;
  name: string;
  color: string;
}

interface BoardColumn {
  id: string;
  name: string;
  category: string;
  position: number;
  // Optional custom accent color (hex string), independent of `category` —
  // null/undefined means "use the category-based default color".
  color?: string | null;
}

// Fallback swatch value shown in the native color picker before a user has
// chosen a custom color — purely a picker starting point, not persisted
// unless the user actually confirms a color (which fires onChange).
const DEFAULT_COLOR_PICKER_VALUE = "#4f46e5";

interface WorkspaceMember {
  userId: string;
  email: string;
  displayName: string;
}

interface CategoryMember {
  userId: string;
  email: string;
  displayName: string;
}

// Plain-English labels for the `ColumnCategory` enum (packages/shared/src/dto/board.ts).
const COLUMN_CATEGORY_OPTIONS: Array<{ value: "todo" | "in_progress" | "done"; label: string }> = [
  { value: "todo", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
];

// Sortable ids for the column-reorder drag layer are prefixed so they never
// collide with the plain columnId used elsewhere (task drop targets via
// `ColumnDropZone`, `tasksByColumn` keys, the move-task API, etc.) — those
// two id spaces are registered as separate droppables within the very same
// `DndContext` and must stay disjoint.
const COLUMN_DRAG_PREFIX = "column-drag:";

const CAN_EDIT_TASK_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER", "MEMBER"]);
const CAN_CREATE_TASK_ROLES = CAN_EDIT_TASK_ROLES;
// Mirrors the `board.manage` permission grant (OWNER/ADMIN/PROJECT_MANAGER —
// see packages/shared/src/roles.ts); MEMBER/VIEWER/CLIENT never see any
// column-management affordance, only the read-only board they already have.
const CAN_MANAGE_BOARD_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);
// Mirrors the `category.manage` permission grant — same role set as board
// management today, kept as its own named constant since the two
// permissions are independent server-side even though the default role
// grants happen to coincide.
const CAN_MANAGE_CATEGORY_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);
// Mirrors the `task.assign` permission grant (packages/shared/src/roles.ts —
// MEMBER has it, unlike task.delete below) — gates the bulk bar's
// Assign/Unassign controls, independent of `task.edit`'s CAN_EDIT_TASK_ROLES.
const CAN_ASSIGN_TASK_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER", "MEMBER"]);
// Mirrors the `task.delete` permission grant — same role set as
// TaskDetailModal.tsx's local CAN_DELETE_ROLES; gates the bulk bar's Delete
// control. MEMBER deliberately excluded (matches single-task delete).
const CAN_DELETE_TASK_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);

// List view's Priority column sorts by severity order, not alphabetically
// (alphabetical would put "high" before "low" before "medium" before
// "urgent", which is meaningless to a user scanning for what's urgent).
const PRIORITY_SORT_RANK: Record<Task["priority"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  urgent: 3,
};

function midpointPosition(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return 1;
  if (prev === null) return next! / 2;
  if (next === null) return prev + 1;
  return (prev + next) / 2;
}

function TaskCard({
  task,
  onOpen,
  draggable,
  canToggleComplete,
  onToggleComplete,
  selectable,
  selected,
  selectionDisabled,
  onToggleSelect,
}: {
  task: Task;
  onOpen: () => void;
  draggable: boolean;
  canToggleComplete: boolean;
  onToggleComplete: (task: Task, completed: boolean) => void;
  selectable: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  onToggleSelect: (task: Task, selected: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !draggable,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`ph-task-card${isDragging ? " ph-task-card-dragging" : ""}`}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
    >
      <div className="ph-task-card-row">
        {selectable && (
          <input
            type="checkbox"
            className="ph-task-checkbox"
            checked={selected}
            disabled={selectionDisabled}
            aria-label={`Select "${task.title}"`}
            title={selectionDisabled ? "You can only select up to 100 tasks at once" : "Select task"}
            // Same rationale as the completion checkbox below: this is an
            // independent control, never the card-open/drag trigger.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onToggleSelect(task, e.target.checked)}
          />
        )}
        {canToggleComplete && (
          <input
            type="checkbox"
            className="ph-task-checkbox"
            checked={false}
            aria-label={`Mark "${task.title}" as done`}
            title="Mark as done"
            // Never let this bubble into the card's own drag/click handling —
            // the checkbox is its own independent control, not the card-open
            // trigger.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleComplete(task, true)}
          />
        )}
        <button type="button" className="ph-task-card-open" onClick={onOpen}>
          <div className="ph-task-card-title">{task.title}</div>
          <div className="ph-task-card-meta">
            <span className={`ph-priority-dot ph-priority-${task.priority}`} title={`Priority: ${task.priority}`} />
            {task.labels.map((l) => (
              <span key={l.labelId} className="ph-label-chip" style={{ background: l.color }}>
                {l.name}
              </span>
            ))}
            {task.assignees.length > 0 && (
              <span style={{ fontSize: "0.72rem", color: "var(--ph-muted)" }}>
                {task.assignees.map((a) => formatUserName(a.displayName, a.isDeleted)).join(", ")}
              </span>
            )}
          </div>
        </button>
      </div>
    </div>
  );
}

export default function KanbanBoardPage({ user }: { user: CurrentUser }) {
  const { workspaceId, projectId, categoryId } = useParams<{
    workspaceId: string;
    projectId: string;
    categoryId: string;
  }>();
  const navigate = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [categoryVisibility, setCategoryVisibility] = useState<"workspace" | "private">("workspace");
  const [role, setRole] = useState<string | null>(null);
  const [columns, setColumns] = useState<BoardColumn[] | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [createTaskColumnId, setCreateTaskColumnId] = useState<string | null>(null);
  // Initial-value-only application of the Personalization tab's "default
  // board view" preference (see lib/personalization.ts) — this does NOT
  // keep the view in sync with the stored preference after mount; clicking
  // Board/List/Calendar/Activity below still just navigates this same local
  // state as before.
  const [view, setView] = useState<"board" | "activity" | "list" | "calendar">(
    () => getStoredDefaultBoardView() ?? "board",
  );

  // List view (Alternate Board Views): sortable table over the exact same
  // `filteredTasks` the Board view's columns are built from — no separate
  // fetch/filter state. Default sort is due-date ascending (soonest-due
  // first), the most actionable default for a flat task list.
  const [listSortKey, setListSortKey] = useState<
    "title" | "assignee" | "priority" | "dueDate" | "column" | "labels"
  >("dueDate");
  const [listSortDir, setListSortDir] = useState<"asc" | "desc">("asc");

  // Bulk task actions: selection is scoped to this one category's board —
  // never preserved across a category/board switch (see the load()-keyed
  // effect below, which wipes it unconditionally on every such switch).
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [projectLabels, setProjectLabels] = useState<ProjectLabel[]>([]);

  // Category management (rename/visibility/members/delete) — same
  // simple-inline-form pattern as column management below, gated on
  // category.manage's role set.
  const [managingCategory, setManagingCategory] = useState(false);
  const [categoryNameDraft, setCategoryNameDraft] = useState("");
  const [categoryVisibilityDraft, setCategoryVisibilityDraft] = useState<"workspace" | "private">("workspace");
  const [savingCategory, setSavingCategory] = useState(false);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [categoryMembers, setCategoryMembers] = useState<CategoryMember[]>([]);

  // Column management — Phase 2's board.manage-gated CRUD, surfaced
  // directly on the board for OWNER/ADMIN/PROJECT_MANAGER.
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [newColumnCategory, setNewColumnCategory] = useState<"todo" | "in_progress" | "done">("todo");
  const [newColumnColor, setNewColumnColor] = useState<string | null>(null);
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [editingColumnName, setEditingColumnName] = useState("");
  const [editingColumnCategory, setEditingColumnCategory] = useState<"todo" | "in_progress" | "done">("todo");
  const [editingColumnColor, setEditingColumnColor] = useState<string | null>(null);

  // Phase 7 search/filter: filtered client-side against the board already
  // fetched in full for this category (simpler and equally correct for a
  // single-category board — see docs/PHASES.md Phase 7 notes). This never
  // calls the server with a different scope; it only narrows what's
  // rendered from `tasks`, which itself only ever contains this category's
  // tasks.
  const [searchQuery, setSearchQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  // Checkbox-completion "history": which column (if any) currently has its
  // completed-tasks list expanded. Independent of the search/priority/etc.
  // filters above — history always shows a column's full completed list,
  // regardless of the active board filters.
  const [openHistoryColumnId, setOpenHistoryColumnId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function showToast(message: string, error = false) {
    setToast({ message, error });
    setTimeout(() => setToast(null), 4000);
  }

  const projectBase = `/api/workspaces/${workspaceId}/projects/${projectId}`;
  const base = `${projectBase}/categories/${categoryId}`;

  async function load() {
    if (!workspaceId || !projectId || !categoryId) return;
    try {
      const ws = await api.get<{ workspace: { name: string }; role: string }>(
        `/api/workspaces/${workspaceId}`,
      );
      setRole(ws.role);

      const projectRes = await api.get<{ project: { name: string } }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}`,
      );
      setProjectName(projectRes.project.name);

      const categoryRes = await api.get<{
        category: { name: string; visibility: "workspace" | "private" };
      }>(base);
      setCategoryName(categoryRes.category.name);
      setCategoryVisibility(categoryRes.category.visibility);
      setCategoryVisibilityDraft(categoryRes.category.visibility);
      setCategoryNameDraft(categoryRes.category.name);

      const columnsRes = await api.get<{ columns: BoardColumn[] }>(`${base}/columns`);
      setColumns(columnsRes.columns.sort((a, b) => a.position - b.position));

      const tasksRes = await api.get<{ tasks: Task[] }>(`${base}/tasks`);
      setTasks(tasksRes.tasks);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate(`/workspace/${workspaceId}/projects/${projectId}/categories`);
        return;
      }
      showToast("Could not load this board. Please try again.", true);
      return;
    }

    // Eagerly load workspace members and the project's full label catalog so
    // the bulk-action bar's Assign/Add-label pickers already have data as
    // soon as the bar appears — previously these were only fetched lazily
    // inside openCategoryManager(), which the bulk bar never calls. Failure
    // here is non-critical to the board itself (same posture as
    // openCategoryManager's own best-effort fetch), so it's a separate,
    // non-fatal try/catch.
    try {
      const [membersRes, labelsRes] = await Promise.all([
        api.get<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspaceId}/members`),
        api.get<{ labels: ProjectLabel[] }>(`${projectBase}/labels`),
      ]);
      setWorkspaceMembers(membersRes.members);
      setProjectLabels(labelsRes.labels);
    } catch {
      // Non-critical — only the bulk bar's Assign/Add-label pickers would
      // show stale/empty options.
    }
  }

  useEffect(() => {
    // Selection is scoped to one category's board at a time — never
    // preserved across a category/board switch.
    setSelectedTaskIds(new Set());
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId, categoryId]);

  // Keeps `selectedTaskIds` from ever pointing at a task no longer present
  // locally — covers the `board.column.changed` full-refetch case (and is a
  // harmless no-op backstop for every other tasks-state update, including
  // this bar's own bulk-mutation results, which already prune succeeded ids
  // themselves).
  useEffect(() => {
    setSelectedTaskIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (tasks.some((t) => t.id === id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  // Real-time collaboration: join this board's workspace/project/category
  // rooms and live-apply task/board events pushed by other users' REST
  // mutations. Task/column mutation events are emitted ONLY to the
  // category's room (see apps/api/src/realtime/realtime.ts#emitToCategory),
  // so joining the category room specifically (not just the project's) is
  // required to receive them. Socket.IO here is push-only — nothing in this
  // effect ever writes state back to the server, it only reflects what the
  // server already persisted.
  useEffect(() => {
    if (!workspaceId || !projectId || !categoryId) return;
    const socket = getSocket();
    joinWorkspaceRoom(workspaceId);
    joinProjectRoom(projectId);
    joinCategoryRoom(categoryId);

    const onTaskCreated = (task: Task) => {
      setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [...prev, task]));
    };
    const onTaskChanged = (task: Task) => {
      if (!task || !task.id) return;
      setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev.map((t) => (t.id === task.id ? task : t)) : prev));
    };
    const onTaskDeleted = ({ id }: { id: string }) => {
      setTasks((prev) => prev.filter((t) => t.id !== id));
      setSelectedTaskId((prev) => (prev === id ? null : prev));
      // Silently drop it from the bulk selection too — no toast, the bar's
      // count just decrements (and hides entirely if this was the last id).
      setSelectedTaskIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    };
    const onBoardColumnChanged = () => {
      load().catch(() => undefined);
    };

    socket.on("task.created", onTaskCreated);
    socket.on("task.updated", onTaskChanged);
    socket.on("task.moved", onTaskChanged);
    socket.on("task.deleted", onTaskDeleted);
    socket.on("board.column.changed", onBoardColumnChanged);

    return () => {
      socket.off("task.created", onTaskCreated);
      socket.off("task.updated", onTaskChanged);
      socket.off("task.moved", onTaskChanged);
      socket.off("task.deleted", onTaskDeleted);
      socket.off("board.column.changed", onBoardColumnChanged);
      leaveProjectRoom(projectId);
      leaveCategoryRoom(categoryId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId, categoryId]);

  const assigneeOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) {
      for (const a of t.assignees) map.set(a.userId, formatUserName(a.displayName, a.isDeleted));
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks]);

  const labelOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) {
      for (const l of t.labels) map.set(l.labelId, l.name);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const now = Date.now();
    return tasks.filter((t) => {
      // Completed tasks (completedAt set) never render in a column's normal
      // task list — they live in that same column's "history" instead (see
      // completedTasksByColumn below). This applies uniformly whether
      // completion came from the checkbox or from being dragged into a
      // done-category column, since both set the exact same field.
      if (t.completedAt) return false;
      if (q && !t.title.toLowerCase().includes(q) && !(t.description ?? "").toLowerCase().includes(q)) {
        return false;
      }
      if (priorityFilter && t.priority !== priorityFilter) return false;
      if (assigneeFilter && !t.assignees.some((a) => a.userId === assigneeFilter)) return false;
      if (labelFilter && !t.labels.some((l) => l.labelId === labelFilter)) return false;
      if (overdueOnly && !(t.dueDate && new Date(t.dueDate).getTime() < now && !t.completedAt)) return false;
      return true;
    });
  }, [tasks, searchQuery, priorityFilter, assigneeFilter, labelFilter, overdueOnly]);

  const hasActiveTaskFilters = Boolean(
    searchQuery || priorityFilter || assigneeFilter || labelFilter || overdueOnly,
  );
  function clearTaskFilters() {
    setSearchQuery("");
    setPriorityFilter("");
    setAssigneeFilter("");
    setLabelFilter("");
    setOverdueOnly(false);
  }

  // List view: same `filteredTasks` as the Board view, just re-sorted per
  // whichever column header was last clicked. `columns` is a dependency
  // because the "Column" sort key resolves each task's columnId to a
  // display name before comparing.
  const sortedListTasks = useMemo(() => {
    const dir = listSortDir === "asc" ? 1 : -1;
    const columnName = (t: Task) => columns?.find((c) => c.id === t.columnId)?.name ?? "";
    const firstAssignee = (t: Task) =>
      t.assignees[0] ? formatUserName(t.assignees[0].displayName, t.assignees[0].isDeleted) : "";
    const firstLabel = (t: Task) => t.labels[0]?.name ?? "";

    // Ascending-oriented comparator for keys where "value present" is
    // universal (assignee/priority/title/column always have *some* value to
    // compare, even if it's an empty string for "no assignee"). Null-having
    // keys (dueDate/labels) are special-cased below via `isEmptyForSort` so
    // "no value" always sorts last in both directions, never inverted by
    // `dir` the way a real value comparison is.
    function baseCompare(a: Task, b: Task): number {
      switch (listSortKey) {
        case "title":
          return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        case "assignee":
          return firstAssignee(a).localeCompare(firstAssignee(b), undefined, { sensitivity: "base" });
        case "priority":
          return PRIORITY_SORT_RANK[a.priority] - PRIORITY_SORT_RANK[b.priority];
        case "dueDate":
          return new Date(a.dueDate as string).getTime() - new Date(b.dueDate as string).getTime();
        case "column":
          return columnName(a).localeCompare(columnName(b), undefined, { sensitivity: "base" });
        case "labels":
          return firstLabel(a).localeCompare(firstLabel(b), undefined, { sensitivity: "base" });
        default:
          return 0;
      }
    }

    function isEmptyForSort(t: Task): boolean {
      if (listSortKey === "dueDate") return !t.dueDate;
      if (listSortKey === "labels") return t.labels.length === 0;
      return false;
    }

    return [...filteredTasks].sort((a, b) => {
      const aEmpty = isEmptyForSort(a);
      const bEmpty = isEmptyForSort(b);
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1; // empty always last, regardless of listSortDir
      if (bEmpty) return -1;
      return baseCompare(a, b) * dir;
    });
  }, [filteredTasks, listSortKey, listSortDir, columns]);

  function handleListSort(key: typeof listSortKey) {
    if (listSortKey === key) {
      setListSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setListSortKey(key);
      setListSortDir("asc");
    }
  }

  const tasksByColumn = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of filteredTasks) {
      const list = map.get(t.columnId) ?? [];
      list.push(t);
      map.set(t.columnId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [filteredTasks]);

  // Per-column "history": every completed task that belongs to this column,
  // independent of the board's active search/priority/assignee/label/overdue
  // filters (history is a separate, always-complete view, not another
  // filtered slice of the board). Derived from the full `tasks` list, not
  // `filteredTasks`. Most-recently-completed first.
  const completedTasksByColumn = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.completedAt) continue;
      const list = map.get(t.columnId) ?? [];
      list.push(t);
      map.set(t.columnId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());
    }
    return map;
  }, [tasks]);

  const canEditTasks = role !== null && CAN_EDIT_TASK_ROLES.has(role);
  const canCreateTasks = role !== null && CAN_CREATE_TASK_ROLES.has(role);
  const canManageBoard = role !== null && CAN_MANAGE_BOARD_ROLES.has(role);
  const canManageCategory = role !== null && CAN_MANAGE_CATEGORY_ROLES.has(role);
  const canAssignTasks = role !== null && CAN_ASSIGN_TASK_ROLES.has(role);
  const canDeleteTasks = role !== null && CAN_DELETE_TASK_ROLES.has(role);
  const canBulkSelect = canEditTasks || canAssignTasks || canDeleteTasks;

  function handleToggleTaskSelected(task: Task, selected: boolean) {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(task.id);
      } else {
        next.delete(task.id);
      }
      return next;
    });
  }

  /**
   * Resolves whatever `over.id` dnd-kit's collision detection landed on to
   * the column it should be interpreted as belonging to, regardless of
   * whether it's a column-drag handle id (`COLUMN_DRAG_PREFIX`-prefixed), a
   * task id, or a plain column id (the `ColumnDropZone` empty-column
   * droppable). Used by both the column-reorder and task-move branches of
   * `handleDragEnd` below.
   */
  function resolveOverColumnId(overId: string): string | null {
    if (overId.startsWith(COLUMN_DRAG_PREFIX)) return overId.slice(COLUMN_DRAG_PREFIX.length);
    const overTask = tasks.find((t) => t.id === overId);
    if (overTask) return overTask.columnId;
    if ((columns ?? []).some((c) => c.id === overId)) return overId;
    return null;
  }

  async function handleColumnReorder(activeColumnId: string, overId: string) {
    if (!canManageBoard || !workspaceId || !projectId || !columns) return;
    const overColumnId = resolveOverColumnId(overId);
    if (!overColumnId || overColumnId === activeColumnId) return;

    const oldIndex = columns.findIndex((c) => c.id === activeColumnId);
    const newIndex = columns.findIndex((c) => c.id === overColumnId);
    if (oldIndex === -1 || newIndex === -1) return;

    const previousColumns = columns;
    const reordered = arrayMove(columns, oldIndex, newIndex);
    setColumns(reordered);

    try {
      const res = await api.post<{ columns: BoardColumn[] }>(`${base}/columns/reorder`, {
        columnIds: reordered.map((c) => c.id),
      });
      setColumns(res.columns.sort((a, b) => a.position - b.position));
    } catch (err) {
      setColumns(previousColumns);
      showToast(err instanceof ApiError ? err.message : "Could not reorder columns.", true);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (!workspaceId || !projectId) return;
    const { active, over } = event;
    if (!over) return;

    const activeIdRaw = String(active.id);
    if (activeIdRaw.startsWith(COLUMN_DRAG_PREFIX)) {
      await handleColumnReorder(activeIdRaw.slice(COLUMN_DRAG_PREFIX.length), String(over.id));
      return;
    }

    if (!canEditTasks) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const activeTask = tasks.find((t) => t.id === activeId);
    if (!activeTask) return;

    // `overId` may resolve to a column-drag handle id if the pointer landed
    // near a column header while dragging a task card — normalize through
    // the same helper column-reordering uses so that edge case still drops
    // the task into that column rather than silently no-op'ing.
    const overIsColumnHandle = overId.startsWith(COLUMN_DRAG_PREFIX);
    const isColumnTarget = overIsColumnHandle || (columns ?? []).some((c) => c.id === overId);
    let targetColumnId: string;
    let overTaskId: string | null = null;
    if (isColumnTarget) {
      targetColumnId = overIsColumnHandle ? overId.slice(COLUMN_DRAG_PREFIX.length) : overId;
    } else {
      const overTask = tasks.find((t) => t.id === overId);
      if (!overTask) return;
      targetColumnId = overTask.columnId;
      overTaskId = overTask.id;
    }

    if (targetColumnId === activeTask.columnId && overTaskId === activeTask.id) return;

    const siblings = (tasksByColumn.get(targetColumnId) ?? []).filter((t) => t.id !== activeId);
    let overIndex = overTaskId ? siblings.findIndex((t) => t.id === overTaskId) : siblings.length;
    if (overIndex === -1) overIndex = siblings.length;

    const beforeTask = siblings[overIndex - 1] ?? null;
    const afterTask = siblings[overIndex] ?? null;

    const previousTasks = tasks;
    const optimisticPosition = midpointPosition(beforeTask?.position ?? null, afterTask?.position ?? null);
    setTasks((prev) =>
      prev.map((t) =>
        t.id === activeId ? { ...t, columnId: targetColumnId, position: optimisticPosition } : t,
      ),
    );

    try {
      const res = await api.post<{ task: Task }>(`${base}/tasks/${activeId}/move`, {
        version: activeTask.version,
        columnId: targetColumnId,
        beforeTaskId: beforeTask?.id ?? null,
        afterTaskId: afterTask?.id ?? null,
      });
      setTasks((prev) => prev.map((t) => (t.id === activeId ? res.task : t)));
    } catch (err) {
      setTasks(previousTasks);
      if (err instanceof ApiError && err.status === 409) {
        showToast("This task was changed by someone else. Refresh to see the latest version.", true);
      } else {
        showToast(err instanceof ApiError ? err.message : "Could not move this task. Please try again.", true);
      }
    }
  }

  async function handleCreateTask(
    columnId: string,
    input: {
      title: string;
      description?: string;
      priority?: Task["priority"];
      startDate?: string | null;
      dueDate?: string | null;
    },
  ): Promise<Task | null> {
    if (!workspaceId || !projectId) return null;
    const title = input.title.trim();
    if (!title) return null;
    try {
      const res = await api.post<{ task: Task }>(`${base}/tasks`, {
        title,
        columnId,
        ...(input.description ? { description: input.description } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.startDate ? { startDate: input.startDate } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
      });
      // Idempotent: the server's own "task.created" broadcast (see
      // onTaskCreated above) is racing this REST response over a separate
      // connection and may already have appended this exact task by id —
      // mirror that handler's dedupe guard so we never render the same
      // task twice, replacing with the freshest server state either way.
      setTasks((prev) =>
        prev.some((t) => t.id === res.task.id)
          ? prev.map((t) => (t.id === res.task.id ? res.task : t))
          : [...prev, res.task],
      );
      return res.task;
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not create this task.", true);
      return null;
    }
  }

  async function handleAddColumn() {
    if (!canManageBoard || !workspaceId || !projectId) return;
    const name = newColumnName.trim();
    if (!name) return;
    try {
      const res = await api.post<{ column: BoardColumn }>(`${base}/columns`, {
        name,
        category: newColumnCategory,
        color: newColumnColor,
      });
      // Same idempotent-append guard as handleCreateTask: the "board.column.changed"
      // socket broadcast (handled by onBoardColumnChanged -> load(), a full
      // refetch/replace) may resolve before this REST response does, so an
      // unconditional append here could double up this column.
      setColumns((prev) => {
        const list = prev ?? [];
        const next = list.some((c) => c.id === res.column.id)
          ? list.map((c) => (c.id === res.column.id ? res.column : c))
          : [...list, res.column];
        return next.sort((a, b) => a.position - b.position);
      });
      setNewColumnName("");
      setNewColumnCategory("todo");
      setNewColumnColor(null);
      setAddingColumn(false);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not create this column.", true);
    }
  }

  function startRenameColumn(column: BoardColumn) {
    setEditingColumnId(column.id);
    setEditingColumnName(column.name);
    setEditingColumnCategory((column.category as "todo" | "in_progress" | "done") ?? "todo");
    setEditingColumnColor(column.color ?? null);
  }

  function cancelRenameColumn() {
    setEditingColumnId(null);
  }

  async function handleSaveRenameColumn(columnId: string) {
    if (!canManageBoard || !workspaceId || !projectId) return;
    const name = editingColumnName.trim();
    if (!name) return;
    try {
      const res = await api.patch<{ column: BoardColumn }>(`${base}/columns/${columnId}`, {
        name,
        category: editingColumnCategory,
        color: editingColumnColor,
      });
      setColumns((prev) =>
        (prev ?? []).map((c) => (c.id === res.column.id ? res.column : c)).sort((a, b) => a.position - b.position),
      );
      setEditingColumnId(null);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not rename this column.", true);
    }
  }

  async function handleDeleteColumn(columnId: string) {
    if (!canManageBoard || !workspaceId || !projectId) return;
    if (!confirm("Delete this column? This cannot be undone.")) return;
    try {
      await api.delete(`${base}/columns/${columnId}`);
      setColumns((prev) => (prev ?? []).filter((c) => c.id !== columnId));
    } catch (err) {
      // The server enforces Restrict (409) when the column still has tasks —
      // surface that exact message rather than a generic failure.
      showToast(
        err instanceof ApiError ? err.message : "Could not delete this column. Please try again.",
        true,
      );
    }
  }

  function handleTaskUpdated(updated: Task) {
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  // Checked/unchecked from either the compact card checkbox or a column's
  // history "Revert" button — same `PATCH .../tasks/:taskId` call the rest
  // of this file already uses for task edits, with the identical
  // 409-version-conflict handling (never a silent overwrite). This never
  // touches `columnId`: the task stays in whatever column it was already in,
  // it just disappears into (or reappears out of) that same column's
  // history via `completedAt`.
  async function handleToggleTaskCompleted(task: Task, completed: boolean) {
    if (!workspaceId || !projectId) return;
    try {
      const res = await api.patch<{ task: Task }>(`${base}/tasks/${task.id}`, {
        version: task.version,
        completed,
      });
      setTasks((prev) => prev.map((t) => (t.id === res.task.id ? res.task : t)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        showToast("This task was changed by someone else. Refresh to see the latest version.", true);
      } else {
        showToast(err instanceof ApiError ? err.message : "Could not update this task. Please try again.", true);
      }
    }
  }

  function handleTaskDeleted(taskId: string) {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    setSelectedTaskId(null);
    setSelectedTaskIds((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
  }

  // ---------------------------------------------------------------------
  // Category management (rename/visibility/members/delete)
  // ---------------------------------------------------------------------

  async function openCategoryManager() {
    setManagingCategory(true);
    if (!workspaceId) return;
    try {
      const membersRes = await api.get<{ members: WorkspaceMember[] }>(
        `/api/workspaces/${workspaceId}/members`,
      );
      setWorkspaceMembers(membersRes.members);
      if (categoryVisibility === "private") {
        const categoryMembersRes = await api.get<{ members: CategoryMember[] }>(`${base}/members`);
        setCategoryMembers(categoryMembersRes.members);
      }
    } catch {
      // Non-critical for board function; the manager panel just shows what
      // it could load.
    }
  }

  async function handleSaveCategory() {
    if (!canManageCategory) return;
    const name = categoryNameDraft.trim();
    if (!name) return;
    setSavingCategory(true);
    try {
      const res = await api.patch<{ category: { name: string; visibility: "workspace" | "private" } }>(base, {
        name,
        visibility: categoryVisibilityDraft,
      });
      setCategoryName(res.category.name);
      setCategoryVisibility(res.category.visibility);
      if (res.category.visibility === "private") {
        const categoryMembersRes = await api.get<{ members: CategoryMember[] }>(`${base}/members`);
        setCategoryMembers(categoryMembersRes.members);
      }
      showToast("Category updated.");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not update this category.", true);
    } finally {
      setSavingCategory(false);
    }
  }

  async function handleAddCategoryMember(userId: string) {
    if (!userId) return;
    try {
      await api.post(`${base}/members`, { userId });
      const categoryMembersRes = await api.get<{ members: CategoryMember[] }>(`${base}/members`);
      setCategoryMembers(categoryMembersRes.members);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not add this member.", true);
    }
  }

  async function handleRemoveCategoryMember(userId: string) {
    try {
      await api.delete(`${base}/members/${userId}`);
      setCategoryMembers((prev) => prev.filter((m) => m.userId !== userId));
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not remove this member.", true);
    }
  }

  async function handleDeleteCategory() {
    if (!canManageCategory || !workspaceId || !projectId) return;
    if (!confirm(`Delete the "${categoryName}" category? This cannot be undone.`)) return;
    try {
      await api.delete(base);
      navigate(`/workspace/${workspaceId}/projects/${projectId}/categories`);
    } catch (err) {
      // Surfaces the backend's exact invariant message — e.g. "Every
      // project must have at least one category..." (last-category rule)
      // or "This category still has tasks in it..." (non-empty rule) —
      // via the same toast convention used for the column-delete-blocked
      // error above.
      showToast(
        err instanceof ApiError ? err.message : "Could not delete this category. Please try again.",
        true,
      );
    }
  }

  return (
    <div className="ph-shell ph-shell-wide">
      <div className="ph-topbar ph-topbar-wide">
        <Brand />
        <div className="ph-topbar-actions">
          <ThemeToggle />
          <NotificationBell />
          <span style={{ fontSize: "0.9rem" }}>{user.displayName}</span>
          <SettingsGearLink />
        </div>
      </div>

      <div className="ph-page-wide">
        <div className="ph-breadcrumb-row">
          <Link
            className="ph-button ph-button-secondary"
            style={{ width: "auto", textDecoration: "none" }}
            to={`/workspace/${workspaceId}/projects/${projectId}/categories`}
          >
            <span aria-hidden="true">‹</span> Back to Categories
          </Link>
          <div className="ph-breadcrumb">
            <Link to="/">Your workspaces</Link> /{" "}
            <Link to={`/workspace/${workspaceId}/projects`}>Projects</Link> /{" "}
            <Link to={`/workspace/${workspaceId}/projects/${projectId}/categories`}>
              {projectName || "..."}
            </Link>{" "}
            / {categoryName || "..."}
          </div>
        </div>

        <div className="ph-page-header">
          <div>
            <h1>
              {categoryName || "Board"}
              {categoryVisibility === "private" && (
                <span className="ph-badge ph-badge-private" style={{ marginLeft: "0.6rem" }}>
                  Private
                </span>
              )}
            </h1>
            <p className="ph-subtitle" style={{ margin: 0 }}>
              {projectName}
            </p>
          </div>
          {canManageCategory && (
            <button
              type="button"
              className="ph-button ph-button-secondary"
              style={{ width: "auto" }}
              onClick={() => (managingCategory ? setManagingCategory(false) : openCategoryManager())}
            >
              {managingCategory ? "Close category settings" : "Category settings"}
            </button>
          )}
        </div>

        {managingCategory && canManageCategory && (
          <div className="ph-card ph-card-wide" style={{ marginBottom: "1.25rem" }}>
            <h1 style={{ fontSize: "1rem" }}>Category settings</h1>
            <div className="ph-field">
              <label htmlFor="categoryName">Name</label>
              <input
                id="categoryName"
                value={categoryNameDraft}
                onChange={(e) => setCategoryNameDraft(e.target.value)}
              />
            </div>
            <div className="ph-field">
              <label htmlFor="categoryVisibility">Visibility</label>
              <select
                id="categoryVisibility"
                value={categoryVisibilityDraft}
                onChange={(e) => {
                  const next = e.target.value as "workspace" | "private";
                  setCategoryVisibilityDraft(next);
                  if (next === "private" && categoryMembers.length === 0) {
                    api
                      .get<{ members: CategoryMember[] }>(`${base}/members`)
                      .then((res) => setCategoryMembers(res.members))
                      .catch(() => undefined);
                  }
                }}
              >
                <option value="workspace">Workspace — visible to every project member</option>
                <option value="private">Private — only category members and managers</option>
              </select>
            </div>
            <div style={{ display: "flex", gap: "0.6rem", marginBottom: "1rem" }}>
              <button
                type="button"
                className="ph-button"
                style={{ width: "auto" }}
                disabled={savingCategory || !categoryNameDraft.trim()}
                onClick={handleSaveCategory}
              >
                {savingCategory ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                className="ph-button ph-button-secondary"
                style={{ width: "auto", borderColor: "var(--ph-error)", color: "var(--ph-error)" }}
                onClick={handleDeleteCategory}
              >
                Delete category
              </button>
            </div>

            {categoryVisibilityDraft === "private" && (
              <div>
                <h2 style={{ fontSize: "0.9rem" }}>Category members</h2>
                <ul className="ph-assignee-list">
                  {categoryMembers.length === 0 && <li style={{ border: "none" }}>No explicit members yet.</li>}
                  {categoryMembers.map((m) => (
                    <li key={m.userId}>
                      <span>{m.displayName}</span>
                      <button className="ph-remove-btn" onClick={() => handleRemoveCategoryMember(m.userId)}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <select
                  value=""
                  onChange={(e) => e.target.value && handleAddCategoryMember(e.target.value)}
                  style={{ marginTop: "0.5rem" }}
                >
                  <option value="">Add a workspace member...</option>
                  {workspaceMembers
                    .filter((m) => !categoryMembers.some((cm) => cm.userId === m.userId))
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.displayName}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </div>
        )}

        <div className="ph-subnav flex-wrap">
          <button
            type="button"
            className={`ph-subnav-link whitespace-nowrap${view === "board" ? " ph-subnav-active" : ""}`}
            onClick={() => setView("board")}
          >
            Board
          </button>
          <button
            type="button"
            className={`ph-subnav-link whitespace-nowrap${view === "list" ? " ph-subnav-active" : ""}`}
            onClick={() => setView("list")}
          >
            List
          </button>
          <button
            type="button"
            className={`ph-subnav-link whitespace-nowrap${view === "calendar" ? " ph-subnav-active" : ""}`}
            onClick={() => setView("calendar")}
          >
            Calendar
          </button>
          <button
            type="button"
            className={`ph-subnav-link whitespace-nowrap${view === "activity" ? " ph-subnav-active" : ""}`}
            onClick={() => setView("activity")}
          >
            Activity
          </button>
          <Link
            className="ph-subnav-link whitespace-nowrap"
            to={`/workspace/${workspaceId}/projects/${projectId}/analytics`}
          >
            Analytics
          </Link>
        </div>

        {(view === "board" || view === "list" || view === "calendar") && (
          <div className="ph-filter-bar">
            <input
              type="search"
              placeholder="Search tasks by title or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search tasks"
            />
            <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} aria-label="Filter by priority">
              <option value="">All priorities</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
            {assigneeOptions.length > 0 && (
              <select
                value={assigneeFilter}
                onChange={(e) => setAssigneeFilter(e.target.value)}
                aria-label="Filter by assignee"
              >
                <option value="">All assignees</option>
                {assigneeOptions.map(([id, displayName]) => (
                  <option key={id} value={id}>
                    {displayName}
                  </option>
                ))}
              </select>
            )}
            {labelOptions.length > 0 && (
              <select value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)} aria-label="Filter by label">
                <option value="">All labels</option>
                {labelOptions.map(([id, labelName]) => (
                  <option key={id} value={id}>
                    {labelName}
                  </option>
                ))}
              </select>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.85rem" }}>
              <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
              Overdue only
            </label>
            {hasActiveTaskFilters && (
              <button
                type="button"
                className="ph-button ph-button-secondary ph-filter-clear"
                onClick={clearTaskFilters}
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {view === "activity" ? (
          workspaceId && projectId ? <ActivityFeed workspaceId={workspaceId} projectId={projectId} /> : null
        ) : view === "list" ? (
          <ListView
            tasks={sortedListTasks}
            columns={columns}
            hasActiveTaskFilters={hasActiveTaskFilters}
            sortKey={listSortKey}
            sortDir={listSortDir}
            onSort={handleListSort}
            onOpenTask={(taskId) => setSelectedTaskId(taskId)}
          />
        ) : view === "calendar" ? (
          <CalendarView
            tasks={filteredTasks}
            hasActiveTaskFilters={hasActiveTaskFilters}
            onOpenTask={(taskId) => setSelectedTaskId(taskId)}
          />
        ) : columns === null ? (
          <p>Loading...</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
            <SortableContext
              items={columns.map((c) => `${COLUMN_DRAG_PREFIX}${c.id}`)}
              strategy={horizontalListSortingStrategy}
            >
              <div className="ph-board">
                {columns.map((column) => {
                  const columnTasks = tasksByColumn.get(column.id) ?? [];
                  const isEditing = editingColumnId === column.id;
                  return (
                    <BoardColumnShell
                      key={column.id}
                      columnId={column.id}
                      category={column.category}
                      color={column.color}
                      draggable={canManageBoard}
                    >
                      {(dragHandleProps) => (
                      <>
                      <div className="ph-board-column-header">
                        {isEditing ? (
                          <div className="ph-inline-form" style={{ flexDirection: "column", alignItems: "stretch", gap: "0.35rem", width: "100%" }}>
                            <input
                              value={editingColumnName}
                              onChange={(e) => setEditingColumnName(e.target.value)}
                              aria-label="Column name"
                              autoFocus
                            />
                            <select
                              value={editingColumnCategory}
                              onChange={(e) =>
                                setEditingColumnCategory(e.target.value as "todo" | "in_progress" | "done")
                              }
                              aria-label="Column category"
                            >
                              {COLUMN_CATEGORY_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                              <label htmlFor="edit-column-color" style={{ fontSize: "0.8rem", color: "var(--ph-muted)" }}>
                                Color (optional)
                              </label>
                              <input
                                id="edit-column-color"
                                type="color"
                                className="ph-color-input"
                                value={editingColumnColor ?? DEFAULT_COLOR_PICKER_VALUE}
                                onChange={(e) => setEditingColumnColor(e.target.value)}
                                aria-label="Column color"
                              />
                              {editingColumnColor && (
                                <button
                                  type="button"
                                  className="ph-icon-btn"
                                  aria-label="Reset column color to category default"
                                  title="Reset to default"
                                  onClick={() => setEditingColumnColor(null)}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                            <div style={{ display: "flex", gap: "0.4rem" }}>
                              <button
                                type="button"
                                className="ph-button"
                                style={{ width: "auto" }}
                                onClick={() => handleSaveRenameColumn(column.id)}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="ph-button ph-button-secondary"
                                style={{ width: "auto" }}
                                onClick={cancelRenameColumn}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", minWidth: 0 }}>
                              {canManageBoard && (
                                <button
                                  type="button"
                                  className="ph-icon-btn ph-column-drag-handle"
                                  aria-label={`Reorder ${column.name}`}
                                  title="Drag to reorder"
                                  {...dragHandleProps.attributes}
                                  {...dragHandleProps.listeners}
                                >
                                  <IconGrip size={16} />
                                </button>
                              )}
                              <span
                                className={`ph-column-dot ph-column-dot-${column.category}`}
                                style={column.color ? { background: column.color } : undefined}
                                title={
                                  column.color
                                    ? `Custom color (category: ${column.category.replace("_", " ")})`
                                    : `Category: ${column.category.replace("_", " ")}`
                                }
                              />
                              <h2>{column.name}</h2>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.2rem" }}>
                              <span className="ph-board-column-count">{columnTasks.length}</span>
                              {canCreateTasks && (
                                <button
                                  type="button"
                                  className="ph-icon-btn"
                                  aria-label={`Add a task to ${column.name}`}
                                  title="Add a task"
                                  onClick={() => setCreateTaskColumnId(column.id)}
                                >
                                  <IconPlus size={16} />
                                </button>
                              )}
                              {canManageBoard && (
                                <>
                                  <button
                                    type="button"
                                    className="ph-icon-btn"
                                    aria-label={`Rename ${column.name}`}
                                    title="Rename column"
                                    onClick={() => startRenameColumn(column)}
                                  >
                                    <IconPencil size={16} />
                                  </button>
                                  <button
                                    type="button"
                                    className="ph-icon-btn"
                                    aria-label={`Delete ${column.name}`}
                                    title="Delete column"
                                    onClick={() => handleDeleteColumn(column.id)}
                                  >
                                    <IconTrash size={16} />
                                  </button>
                                </>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                      <SortableContext
                        items={columnTasks.map((t) => t.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <ColumnDropZone columnId={column.id}>
                          {columnTasks.length === 0 ? (
                            <div className="ph-empty-state" style={{ padding: "1rem 0.5rem" }}>
                              No tasks yet.
                            </div>
                          ) : (
                            columnTasks.map((task) => (
                              <TaskCard
                                key={task.id}
                                task={task}
                                draggable={canEditTasks}
                                canToggleComplete={canEditTasks}
                                onToggleComplete={handleToggleTaskCompleted}
                                onOpen={() => setSelectedTaskId(task.id)}
                                selectable={canBulkSelect}
                                selected={selectedTaskIds.has(task.id)}
                                selectionDisabled={
                                  !selectedTaskIds.has(task.id) && selectedTaskIds.size >= 100
                                }
                                onToggleSelect={handleToggleTaskSelected}
                              />
                            ))
                          )}
                        </ColumnDropZone>
                      </SortableContext>

                      <div className="ph-board-column-footer">
                        <button
                          type="button"
                          className="ph-column-history-toggle"
                          onClick={() =>
                            setOpenHistoryColumnId((prev) => (prev === column.id ? null : column.id))
                          }
                        >
                          {openHistoryColumnId === column.id
                            ? "Hide history"
                            : `History (${(completedTasksByColumn.get(column.id) ?? []).length})`}
                        </button>
                        {openHistoryColumnId === column.id && (
                          <ul className="ph-column-history-list">
                            {(completedTasksByColumn.get(column.id) ?? []).length === 0 && (
                              <li className="ph-column-history-empty">No completed tasks yet.</li>
                            )}
                            {(completedTasksByColumn.get(column.id) ?? []).map((completedTask) => (
                              <li key={completedTask.id} className="ph-column-history-item">
                                <span className="ph-column-history-title">{completedTask.title}</span>
                                {canEditTasks && (
                                  <button
                                    type="button"
                                    className="ph-remove-btn"
                                    onClick={() => handleToggleTaskCompleted(completedTask, false)}
                                  >
                                    Revert
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      </>
                      )}
                    </BoardColumnShell>
                  );
                })}

                {canManageBoard && (
                  <div className="ph-board-column ph-board-column-add">
                    {addingColumn ? (
                      <div className="ph-inline-form" style={{ flexDirection: "column", alignItems: "stretch", gap: "0.4rem" }}>
                        <input
                          placeholder="Column name"
                          value={newColumnName}
                          onChange={(e) => setNewColumnName(e.target.value)}
                          aria-label="New column name"
                          autoFocus
                        />
                        <select
                          value={newColumnCategory}
                          onChange={(e) => setNewColumnCategory(e.target.value as "todo" | "in_progress" | "done")}
                          aria-label="New column category"
                        >
                          {COLUMN_CATEGORY_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                          <label htmlFor="new-column-color" style={{ fontSize: "0.8rem", color: "var(--ph-muted)" }}>
                            Color (optional)
                          </label>
                          <input
                            id="new-column-color"
                            type="color"
                            className="ph-color-input"
                            value={newColumnColor ?? DEFAULT_COLOR_PICKER_VALUE}
                            onChange={(e) => setNewColumnColor(e.target.value)}
                            aria-label="New column color"
                          />
                          {newColumnColor && (
                            <button
                              type="button"
                              className="ph-icon-btn"
                              aria-label="Reset column color to category default"
                              title="Reset to default"
                              onClick={() => setNewColumnColor(null)}
                            >
                              ×
                            </button>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: "0.4rem" }}>
                          <button
                            type="button"
                            className="ph-button"
                            style={{ width: "auto" }}
                            disabled={!newColumnName.trim()}
                            onClick={handleAddColumn}
                          >
                            Add
                          </button>
                          <button
                            type="button"
                            className="ph-button ph-button-secondary"
                            style={{ width: "auto" }}
                            onClick={() => {
                              setAddingColumn(false);
                              setNewColumnName("");
                              setNewColumnCategory("todo");
                              setNewColumnColor(null);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="ph-button ph-button-secondary"
                        onClick={() => setAddingColumn(true)}
                      >
                        <IconPlus size={15} />
                        Add column
                      </button>
                    )}
                  </div>
                )}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {toast && <div className={`ph-toast${toast.error ? " ph-toast-error" : ""}`}>{toast.message}</div>}

      {canBulkSelect && selectedTaskIds.size > 0 && columns !== null && (
        <BulkActionBar
          base={base}
          tasks={tasks}
          setTasks={setTasks}
          selectedTaskIds={selectedTaskIds}
          setSelectedTaskIds={setSelectedTaskIds}
          columns={columns}
          workspaceMembers={workspaceMembers}
          projectLabels={projectLabels}
          canEditTasks={canEditTasks}
          canAssignTasks={canAssignTasks}
          canDeleteTasks={canDeleteTasks}
          showToast={showToast}
        />
      )}

      {createTaskColumnId && workspaceId && projectId && (
        <CreateTaskModal
          onClose={() => setCreateTaskColumnId(null)}
          onCreate={async (input) => {
            const created = await handleCreateTask(createTaskColumnId, input);
            if (created) {
              setCreateTaskColumnId(null);
              // Continue the flow into the full task editor so the user can
              // immediately add assignees/labels/etc. — the creation modal
              // deliberately doesn't support those (see CreateTaskModal.tsx).
              setSelectedTaskId(created.id);
            }
            return created;
          }}
        />
      )}

      {selectedTaskId && workspaceId && projectId && categoryId && (
        <TaskDetailModal
          workspaceId={workspaceId}
          projectId={projectId}
          categoryId={categoryId}
          taskId={selectedTaskId}
          role={role}
          currentUserId={user.id}
          allTasks={tasks}
          onClose={() => setSelectedTaskId(null)}
          onUpdated={handleTaskUpdated}
          onDeleted={handleTaskDeleted}
        />
      )}
    </div>
  );
}

interface DragHandleProps {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
}

function BoardColumnShell({
  columnId,
  category,
  color,
  draggable,
  children,
}: {
  columnId: string;
  category: string;
  color?: string | null;
  draggable: boolean;
  children: (dragHandleProps: DragHandleProps) => React.ReactNode;
}) {
  // The column itself is the sortable node (using the prefixed drag id — see
  // COLUMN_DRAG_PREFIX), but `attributes`/`listeners` are handed to the
  // caller to attach to a small dedicated drag-handle icon in the header
  // only — never to the whole column — so header buttons stay clickable and
  // task cards inside remain independently draggable via their own
  // `useSortable` in `TaskCard`, without both trying to claim the same
  // pointerdown.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${COLUMN_DRAG_PREFIX}${columnId}`,
    disabled: !draggable,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // A custom `color` naturally wins over the CSS attribute-selector rule
    // (.ph-board-column[data-category="..."]) since inline styles have
    // higher specificity than any stylesheet rule; when unset this is
    // `undefined`, which falls straight through to that CSS default.
    borderTopColor: color ?? undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-category={category}
      className={`ph-board-column${isDragging ? " ph-board-column-dragging" : ""}`}
    >
      {children({ attributes, listeners })}
    </div>
  );
}

type ListSortKey = "title" | "assignee" | "priority" | "dueDate" | "column" | "labels";

const PRIORITY_DISPLAY_LABEL: Record<Task["priority"], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

/**
 * List view (Alternate Board Views): a sortable table over the same task
 * data/filters the Board view uses, with row/title clicks opening the exact
 * same `TaskDetailModal` instance the Board view's cards open (via
 * `onOpenTask`, which is just `setSelectedTaskId` from the parent). Purely
 * additive alongside the Board/Activity views — no drag-and-drop, no
 * column CRUD, no bulk-select, no custom-field columns (deliberately out of
 * scope for this table; see the tracker's exact column list).
 */
function ListView({
  tasks,
  columns,
  hasActiveTaskFilters,
  sortKey,
  sortDir,
  onSort,
  onOpenTask,
}: {
  tasks: Task[];
  columns: BoardColumn[] | null;
  hasActiveTaskFilters: boolean;
  sortKey: ListSortKey;
  sortDir: "asc" | "desc";
  onSort: (key: ListSortKey) => void;
  onOpenTask: (taskId: string) => void;
}) {
  if (columns === null) {
    return <p>Loading...</p>;
  }

  const now = Date.now();

  function SortHeader({ label, sortKeyValue }: { label: string; sortKeyValue: ListSortKey }) {
    const active = sortKey === sortKeyValue;
    return (
      <th>
        <button type="button" className="ph-list-sort-button" onClick={() => onSort(sortKeyValue)}>
          {label}
          {active && <span aria-hidden="true"> {sortDir === "asc" ? "▲" : "▼"}</span>}
        </button>
      </th>
    );
  }

  return (
    <div className="ph-list-table-wrap">
      <table className="ph-list-table">
        <thead>
          <tr>
            <SortHeader label="Title" sortKeyValue="title" />
            <SortHeader label="Assignee" sortKeyValue="assignee" />
            <SortHeader label="Priority" sortKeyValue="priority" />
            <SortHeader label="Due Date" sortKeyValue="dueDate" />
            <SortHeader label="Column" sortKeyValue="column" />
            <SortHeader label="Labels" sortKeyValue="labels" />
          </tr>
        </thead>
        <tbody>
          {tasks.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ padding: 0, border: "none" }}>
                <div className="ph-empty-state">
                  {hasActiveTaskFilters ? "No tasks match the current filters." : "No tasks yet."}
                </div>
              </td>
            </tr>
          ) : (
            tasks.map((task) => {
              const columnName = columns.find((c) => c.id === task.columnId)?.name ?? "—";
              const isOverdue = Boolean(task.dueDate && new Date(task.dueDate).getTime() < now);
              return (
                <tr key={task.id} className="ph-list-row" onClick={() => onOpenTask(task.id)}>
                  <td>
                    <button
                      type="button"
                      className="ph-list-title-open"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenTask(task.id);
                      }}
                    >
                      {task.title}
                    </button>
                  </td>
                  <td>
                    {task.assignees.length > 0
                      ? task.assignees.map((a) => formatUserName(a.displayName, a.isDeleted)).join(", ")
                      : "—"}
                  </td>
                  <td>
                    <span className={`ph-badge ph-badge-priority-${task.priority}`}>
                      {PRIORITY_DISPLAY_LABEL[task.priority]}
                    </span>
                  </td>
                  <td className={isOverdue ? "ph-list-overdue" : undefined}>
                    {task.dueDate ? new Date(task.dueDate).toLocaleDateString() : "—"}
                  </td>
                  <td>{columnName}</td>
                  <td>
                    {task.labels.length > 0 && (
                      <div className="ph-list-labels">
                        {task.labels.map((l) => (
                          <span key={l.labelId} className="ph-label-chip" style={{ background: l.color }}>
                            {l.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

const CALENDAR_WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CALENDAR_MAX_VISIBLE_TASKS = 3;

function dayKey(year: number, month: number, day: number): string {
  return `${year}-${month}-${day}`;
}

/**
 * Alternate Board Views — Calendar view: a month grid over the same task
 * data/filters the Board and List views use, plus an always-visible
 * "Unscheduled" section for tasks with no due date. Purely additive
 * alongside Board/List/Activity — no drag-and-drop, no new fetch, no new
 * modal (task clicks open the exact same `TaskDetailModal` instance via
 * `onOpenTask`, just like List view's row clicks). All calendar-specific
 * state (current month, which day cell is expanded) lives locally in this
 * component and resets whenever it unmounts.
 */
function CalendarView({
  tasks,
  hasActiveTaskFilters,
  onOpenTask,
}: {
  tasks: Task[];
  hasActiveTaskFilters: boolean;
  onOpenTask: (taskId: string) => void;
}) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [expandedDayKey, setExpandedDayKey] = useState<string | null>(null);

  function goToPrevMonth() {
    const d = new Date(viewYear, viewMonth - 1, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
    setExpandedDayKey(null);
  }

  function goToNextMonth() {
    const d = new Date(viewYear, viewMonth + 1, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
    setExpandedDayKey(null);
  }

  function goToToday() {
    const now = new Date();
    setViewYear(now.getFullYear());
    setViewMonth(now.getMonth());
    setExpandedDayKey(null);
  }

  // Group every task with a non-null dueDate by its local calendar day
  // (getFullYear/getMonth/getDate, never UTC — so a task's due date lands
  // on the same day a user sees elsewhere in the app, e.g. List view's
  // toLocaleDateString() due-date column).
  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.dueDate) continue;
      const d = new Date(t.dueDate);
      const key = dayKey(d.getFullYear(), d.getMonth(), d.getDate());
      const list = map.get(key) ?? [];
      list.push(t);
      map.set(key, list);
    }
    return map;
  }, [tasks]);

  const unscheduledTasks = useMemo(() => tasks.filter((t) => t.dueDate === null), [tasks]);

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const leadingBlanks = firstOfMonth.getDay(); // 0 (Sun) .. 6 (Sat)
  const totalCells = leadingBlanks + daysInMonth;
  const trailingBlanks = (7 - (totalCells % 7)) % 7;

  const cells: Array<{ day: number } | null> = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => ({ day: i + 1 })),
    ...Array.from({ length: trailingBlanks }, () => null),
  ];

  const todayKey = dayKey(today.getFullYear(), today.getMonth(), today.getDate());
  const todayStartOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  return (
    <div className="ph-calendar">
      <div className="ph-calendar-nav">
        <button type="button" className="ph-button ph-button-secondary" onClick={goToPrevMonth}>
          ‹ Prev
        </button>
        <div className="ph-calendar-nav-label">{monthLabel}</div>
        <button type="button" className="ph-button ph-button-secondary" onClick={goToNextMonth}>
          Next ›
        </button>
        <button type="button" className="ph-button ph-button-secondary" onClick={goToToday}>
          Today
        </button>
        {hasActiveTaskFilters && tasks.length === 0 && (
          <span className="ph-calendar-filter-note">No tasks match the current filters.</span>
        )}
      </div>

      <div className="ph-calendar-grid">
        {CALENDAR_WEEKDAY_LABELS.map((label) => (
          <div key={label} className="ph-calendar-weekday">
            {label}
          </div>
        ))}
        {cells.map((cell, idx) => {
          if (cell === null) {
            return <div key={`blank-${idx}`} className="ph-calendar-day ph-calendar-day-blank" />;
          }
          const key = dayKey(viewYear, viewMonth, cell.day);
          const dayTasks = tasksByDay.get(key) ?? [];
          const isToday = key === todayKey;
          const isExpanded = expandedDayKey === key;
          const visibleTasks = isExpanded ? dayTasks : dayTasks.slice(0, CALENDAR_MAX_VISIBLE_TASKS);
          const remaining = dayTasks.length - CALENDAR_MAX_VISIBLE_TASKS;

          return (
            <div key={key} className={`ph-calendar-day${isToday ? " ph-calendar-day-today" : ""}`}>
              <div className="ph-calendar-day-number">{cell.day}</div>
              <div className="ph-calendar-day-tasks">
                {visibleTasks.map((task) => {
                  const taskDayStart = task.dueDate
                    ? new Date(new Date(task.dueDate).getFullYear(), new Date(task.dueDate).getMonth(), new Date(task.dueDate).getDate()).getTime()
                    : null;
                  const isOverdue = taskDayStart !== null && taskDayStart < todayStartOfDay;
                  return (
                    <button
                      key={task.id}
                      type="button"
                      className={`ph-calendar-task-chip${isOverdue ? " ph-calendar-task-chip-overdue" : ""}`}
                      title={task.title}
                      onClick={() => onOpenTask(task.id)}
                    >
                      {task.title}
                    </button>
                  );
                })}
                {dayTasks.length > CALENDAR_MAX_VISIBLE_TASKS && (
                  <button
                    type="button"
                    className="ph-calendar-more-toggle"
                    onClick={() => setExpandedDayKey(isExpanded ? null : key)}
                  >
                    {isExpanded ? "Show less" : `+${remaining} more`}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="ph-calendar-unscheduled">
        <h3>Unscheduled ({unscheduledTasks.length})</h3>
        {unscheduledTasks.length === 0 ? (
          <div className="ph-empty-state">No unscheduled tasks.</div>
        ) : (
          <div className="ph-calendar-unscheduled-list">
            {unscheduledTasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className="ph-calendar-unscheduled-row"
                onClick={() => onOpenTask(task.id)}
              >
                {task.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ColumnDropZone({ columnId, children }: { columnId: string; children: React.ReactNode }) {
  // Registers the column body itself as a droppable target (id = columnId)
  // so dropping into an empty column — where there are no sortable task
  // items to land on — still resolves `over.id` to the column.
  const { setNodeRef } = useDroppable({ id: columnId });
  return (
    <div ref={setNodeRef} className="ph-board-column-body">
      {children}
    </div>
  );
}
