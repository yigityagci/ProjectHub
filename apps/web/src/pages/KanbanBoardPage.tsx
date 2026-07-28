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
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import { getSocket, joinWorkspaceRoom, joinProjectRoom, leaveProjectRoom } from "../lib/socket.js";
import NotificationBell from "../components/NotificationBell.js";
import TaskDetailModal from "./TaskDetailModal.js";
import type { CurrentUser } from "../App.js";
import type { Task } from "./task-types.js";

interface BoardColumn {
  id: string;
  name: string;
  category: string;
  position: number;
}

const CAN_EDIT_TASK_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER", "MEMBER"]);
const CAN_CREATE_TASK_ROLES = CAN_EDIT_TASK_ROLES;

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
}: {
  task: Task;
  onOpen: () => void;
  draggable: boolean;
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
    <button
      ref={setNodeRef}
      style={style}
      className={`ph-task-card${isDragging ? " ph-task-card-dragging" : ""}`}
      onClick={onOpen}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
    >
      <div className="ph-task-card-title">{task.title}</div>
      <div className="ph-task-card-meta">
        <span className={`ph-priority-dot ph-priority-${task.priority}`} title={`Priority: ${task.priority}`} />
        {task.labels.map((l) => (
          <span key={l.labelId} className="ph-label-chip" style={{ background: l.color }}>
            {l.name}
          </span>
        ))}
        {task.assignees.length > 0 && (
          <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
            {task.assignees.map((a) => a.displayName).join(", ")}
          </span>
        )}
      </div>
    </button>
  );
}

export default function KanbanBoardPage({ user }: { user: CurrentUser }) {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const navigate = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [columns, setColumns] = useState<BoardColumn[] | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newTaskTitleByColumn, setNewTaskTitleByColumn] = useState<Record<string, string>>({});

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function showToast(message: string, error = false) {
    setToast({ message, error });
    setTimeout(() => setToast(null), 4000);
  }

  async function load() {
    if (!workspaceId || !projectId) return;
    try {
      const ws = await api.get<{ workspace: { name: string }; role: string }>(
        `/api/workspaces/${workspaceId}`,
      );
      setRole(ws.role);

      const projectRes = await api.get<{ project: { name: string } }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}`,
      );
      setProjectName(projectRes.project.name);

      const columnsRes = await api.get<{ columns: BoardColumn[] }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/columns`,
      );
      setColumns(columnsRes.columns.sort((a, b) => a.position - b.position));

      const tasksRes = await api.get<{ tasks: Task[] }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/tasks`,
      );
      setTasks(tasksRes.tasks);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate(`/workspace/${workspaceId}/projects`);
        return;
      }
      showToast("Could not load this board. Please try again.", true);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId]);

  // Real-time collaboration: join this board's workspace/project rooms and
  // live-apply task/board events pushed by other users' REST mutations.
  // Socket.IO here is push-only — nothing in this effect ever writes state
  // back to the server, it only reflects what the server already persisted.
  useEffect(() => {
    if (!workspaceId || !projectId) return;
    const socket = getSocket();
    joinWorkspaceRoom(workspaceId);
    joinProjectRoom(projectId);

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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId]);

  const tasksByColumn = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      const list = map.get(t.columnId) ?? [];
      list.push(t);
      map.set(t.columnId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [tasks]);

  const canEditTasks = role !== null && CAN_EDIT_TASK_ROLES.has(role);
  const canCreateTasks = role !== null && CAN_CREATE_TASK_ROLES.has(role);

  async function handleDragEnd(event: DragEndEvent) {
    if (!canEditTasks || !workspaceId || !projectId) return;
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const activeTask = tasks.find((t) => t.id === activeId);
    if (!activeTask) return;

    const isColumnTarget = (columns ?? []).some((c) => c.id === overId);
    let targetColumnId: string;
    let overTaskId: string | null = null;
    if (isColumnTarget) {
      targetColumnId = overId;
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
      const res = await api.post<{ task: Task }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/tasks/${activeId}/move`,
        {
          version: activeTask.version,
          columnId: targetColumnId,
          beforeTaskId: beforeTask?.id ?? null,
          afterTaskId: afterTask?.id ?? null,
        },
      );
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

  async function handleCreateTask(columnId: string) {
    if (!workspaceId || !projectId) return;
    const title = (newTaskTitleByColumn[columnId] ?? "").trim();
    if (!title) return;
    try {
      const res = await api.post<{ task: Task }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/tasks`,
        { title, columnId },
      );
      setTasks((prev) => [...prev, res.task]);
      setNewTaskTitleByColumn((prev) => ({ ...prev, [columnId]: "" }));
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not create this task.", true);
    }
  }

  function handleTaskUpdated(updated: Task) {
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  function handleTaskDeleted(taskId: string) {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    setSelectedTaskId(null);
  }

  return (
    <div className="ph-shell ph-shell-wide">
      <div className="ph-topbar ph-topbar-wide">
        <Brand />
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <NotificationBell />
          <span style={{ fontSize: "0.9rem" }}>{user.displayName}</span>
        </div>
      </div>

      <div className="ph-page-wide">
        <div className="ph-breadcrumb">
          <Link to="/">Your workspaces</Link> /{" "}
          <Link to={`/workspace/${workspaceId}/projects`}>Projects</Link> / {projectName || "..."}
        </div>

        <div className="ph-page-header">
          <div>
            <h1>{projectName || "Board"}</h1>
          </div>
        </div>

        {columns === null ? (
          <p>Loading...</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
            <div className="ph-board">
              {columns.map((column) => {
                const columnTasks = tasksByColumn.get(column.id) ?? [];
                return (
                  <div key={column.id} className="ph-board-column">
                    <div className="ph-board-column-header">
                      <h2>{column.name}</h2>
                      <span className="ph-board-column-count">{columnTasks.length}</span>
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
                              onOpen={() => setSelectedTaskId(task.id)}
                            />
                          ))
                        )}
                      </ColumnDropZone>
                    </SortableContext>
                    {canCreateTasks && (
                      <form
                        style={{ marginTop: "0.6rem" }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleCreateTask(column.id);
                        }}
                      >
                        <input
                          placeholder="Add a task..."
                          value={newTaskTitleByColumn[column.id] ?? ""}
                          onChange={(e) =>
                            setNewTaskTitleByColumn((prev) => ({ ...prev, [column.id]: e.target.value }))
                          }
                          style={{
                            width: "100%",
                            padding: "0.4rem 0.5rem",
                            borderRadius: "6px",
                            border: "1px solid var(--ph-border)",
                            fontSize: "0.85rem",
                            background: "transparent",
                            color: "inherit",
                          }}
                        />
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          </DndContext>
        )}
      </div>

      {toast && <div className={`ph-toast${toast.error ? " ph-toast-error" : ""}`}>{toast.message}</div>}

      {selectedTaskId && workspaceId && projectId && (
        <TaskDetailModal
          workspaceId={workspaceId}
          projectId={projectId}
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
