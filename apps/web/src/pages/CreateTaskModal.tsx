import { useState } from "react";
import { IconX } from "../components/Icons.js";
import Select from "../components/Select.js";
import type { Task, TaskTemplate } from "./task-types.js";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

interface ProjectLabel {
  id: string;
  name: string;
  color: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: Task["priority"];
  startDate?: string | null;
  dueDate?: string | null;
  labelIds?: string[];
  // Client-side-only metadata (never sent to the server — see
  // KanbanBoardPage.tsx's `labelIds`/`taskInput` destructuring), used only to
  // name the source template in the post-creation "labels applied" toast.
  templateName?: string;
}

/**
 * Task-creation popup, opened via the "+" button on a Kanban column header
 * (see KanbanBoardPage.tsx). Deliberately limited to the fields
 * `createTaskSchema` (packages/shared/src/dto/task.ts) accepts at creation
 * time — title/description/priority/startDate/dueDate. Assignees, labels,
 * milestone, subtasks and dependencies are all set via separate endpoints
 * after creation, so this modal hands off to `TaskDetailModal` immediately
 * on success instead of trying to collect them upfront.
 *
 * "Start from a template" (optional) is a purely client-side prefill: no
 * `templateId` is ever sent to the server (createTaskSchema stays exactly as
 * it was). Picking a template just sets local title/description/priority
 * state, and tracks the template's `defaultLabelIds` in `labelIds` on the
 * `onCreate` payload — the parent (KanbanBoardPage.tsx) is responsible for
 * actually attaching those labels after the task is created, via the
 * existing per-label attach endpoint.
 */
export default function CreateTaskModal({
  templates = [],
  projectLabels = [],
  onClose,
  onCreate,
}: {
  templates?: TaskTemplate[];
  projectLabels?: ProjectLabel[];
  onClose: () => void;
  onCreate: (input: CreateTaskInput) => Promise<Task | null>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateLabelIds, setTemplateLabelIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const canSubmit = title.trim().length > 0 && !creating;

  function handleSelectTemplate(templateId: string) {
    setSelectedTemplateId(templateId);
    if (!templateId) {
      // Re-selecting "Blank task" is a no-op: it never clears fields the
      // user has already edited.
      return;
    }
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    setTitle(template.titleTemplate);
    setDescription(template.description ?? "");
    setPriority(template.priority ?? "medium");
    setTemplateLabelIds(template.defaultLabelIds);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    setError(null);
    try {
      const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
      const created = await onCreate({
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        startDate: startDate ? new Date(startDate).toISOString() : null,
        dueDate: dueDate ? new Date(dueDate).toISOString() : null,
        ...(templateLabelIds.length > 0 ? { labelIds: templateLabelIds } : {}),
        ...(selectedTemplate ? { templateName: selectedTemplate.name } : {}),
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
            <IconX size={18} />
          </button>
        </div>

        {error && <div className="ph-alert ph-alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          {templates.length > 0 && (
            <div className="ph-field">
              <label>Start from a template (optional)</label>
              <Select
                aria-label="Start from a template (optional)"
                value={selectedTemplateId}
                onChange={handleSelectTemplate}
                options={[
                  { value: "", label: "Blank task" },
                  ...templates.map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
              {templateLabelIds.length > 0 && (
                <div style={{ marginTop: "0.4rem" }}>
                  <span style={{ fontSize: "0.78rem", color: "var(--ph-muted)" }}>Labels applied automatically:</span>
                  <div className="ph-task-card-meta" style={{ marginTop: "0.25rem" }}>
                    {templateLabelIds.map((labelId) => {
                      const label = projectLabels.find((l) => l.id === labelId);
                      if (!label) return null;
                      return (
                        <span key={labelId} className="ph-label-chip" style={{ background: label.color }}>
                          {label.name}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

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
            <Select
              aria-label="Priority"
              value={priority}
              onChange={(v) => setPriority(v as Task["priority"])}
              options={PRIORITIES.map((p) => ({ value: p, label: p }))}
            />
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
