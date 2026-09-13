import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api.js";
import { IconPencil, IconTrash } from "../components/Icons.js";
import Select from "../components/Select.js";
import type { Task, TaskTemplate } from "./task-types.js";

const PRIORITIES: Task["priority"][] = ["low", "medium", "high", "urgent"];

interface ProjectLabel {
  id: string;
  name: string;
  color: string;
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}

/**
 * Project Settings' "Task templates" management panel: create/edit/delete
 * the canned task blueprints (TaskTemplate) available to the create-from-
 * template quick action on this project's board (see KanbanBoardPage.tsx /
 * CreateTaskModal.tsx). Modeled on ProjectCustomFieldsPanel.tsx, minus all
 * position/reorder logic — templates have no position field and are always
 * listed in creation order (see the architecture note on TaskTemplate in
 * schema.prisma).
 *
 * Callers must gate rendering this component on the `task_template.manage`
 * role set themselves (see ProjectSettingsPage.tsx) — this component does
 * not re-check the caller's role, matching ProjectCustomFieldsPanel's own
 * convention.
 */
export default function ProjectTaskTemplatesPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const base = `/api/workspaces/${workspaceId}/projects/${projectId}/task-templates`;
  const labelsBase = `/api/workspaces/${workspaceId}/projects/${projectId}/labels`;

  const [templates, setTemplates] = useState<TaskTemplate[] | null>(null);
  const [labels, setLabels] = useState<ProjectLabel[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newTitleTemplate, setNewTitleTemplate] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPriority, setNewPriority] = useState<Task["priority"]>("medium");
  const [newLabelIds, setNewLabelIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTitleTemplate, setEditTitleTemplate] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState<Task["priority"]>("medium");
  const [editLabelIds, setEditLabelIds] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  async function load() {
    setListError(null);
    try {
      const [templatesRes, labelsRes] = await Promise.all([
        api.get<{ templates: TaskTemplate[] }>(base),
        api.get<{ labels: ProjectLabel[] }>(labelsBase),
      ]);
      setTemplates(templatesRes.templates);
      setLabels(labelsRes.labels);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Could not load task templates.");
      setTemplates([]);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const res = await api.post<{ template: TaskTemplate }>(base, {
        name: newName.trim(),
        titleTemplate: newTitleTemplate.trim(),
        ...(newDescription.trim() ? { description: newDescription.trim() } : {}),
        priority: newPriority,
        ...(newLabelIds.length > 0 ? { defaultLabelIds: newLabelIds } : {}),
      });
      setTemplates((prev) => [...(prev ?? []), res.template]);
      setNewName("");
      setNewTitleTemplate("");
      setNewDescription("");
      setNewPriority("medium");
      setNewLabelIds([]);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this task template.");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(template: TaskTemplate) {
    setEditingId(template.id);
    setEditName(template.name);
    setEditTitleTemplate(template.titleTemplate);
    setEditDescription(template.description ?? "");
    setEditPriority(template.priority ?? "medium");
    setEditLabelIds(template.defaultLabelIds.slice());
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function handleSaveEdit(template: TaskTemplate) {
    setEditError(null);
    setSavingEdit(true);
    try {
      const res = await api.patch<{ template: TaskTemplate }>(`${base}/${template.id}`, {
        name: editName.trim(),
        titleTemplate: editTitleTemplate.trim(),
        description: editDescription.trim() ? editDescription.trim() : null,
        priority: editPriority,
        defaultLabelIds: editLabelIds,
      });
      setTemplates((prev) => (prev ?? []).map((t) => (t.id === template.id ? res.template : t)));
      setEditingId(null);
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : "Could not update this task template.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete(templateId: string) {
    setDeleteError(null);
    try {
      await api.delete(`${base}/${templateId}`);
      setTemplates((prev) => (prev ?? []).filter((t) => t.id !== templateId));
      setConfirmingDeleteId(null);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete this task template.");
    }
  }

  function labelChips(selectedIds: string[], onToggle: (id: string) => void) {
    if (labels.length === 0) {
      return <span style={{ fontSize: "0.85rem", color: "var(--ph-muted)" }}>No labels in this project yet.</span>;
    }
    return (
      <div className="ph-task-card-meta">
        {labels.map((l) => {
          const selected = selectedIds.includes(l.id);
          return (
            <button
              key={l.id}
              type="button"
              className="ph-label-chip"
              style={{
                background: selected ? l.color : "transparent",
                color: selected ? "white" : l.color,
                border: `1px solid ${l.color}`,
                cursor: "pointer",
              }}
              onClick={() => onToggle(l.id)}
            >
              {l.name}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
      <h1 style={{ fontSize: "1rem" }}>Task templates</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Save reusable task blueprints — title, description, priority, and default labels — so creating similar
        tasks on this board takes one click.
      </p>

      {listError && <div className="ph-alert ph-alert-error">{listError}</div>}
      {deleteError && <div className="ph-alert ph-alert-error">{deleteError}</div>}

      {templates === null ? (
        <p>Loading...</p>
      ) : templates.length === 0 ? (
        <div className="ph-empty-state">No task templates yet.</div>
      ) : (
        <ul className="ph-assignee-list">
          {templates.map((template) => (
            <li key={template.id} style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0, margin: "0 0.5rem" }}>
                {editingId === template.id ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    {editError && <div className="ph-alert ph-alert-error">{editError}</div>}
                    <div className="ph-field">
                      <label htmlFor={`editName-${template.id}`}>Name</label>
                      <input
                        id={`editName-${template.id}`}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    </div>
                    <div className="ph-field">
                      <label htmlFor={`editTitle-${template.id}`}>Task title</label>
                      <input
                        id={`editTitle-${template.id}`}
                        value={editTitleTemplate}
                        onChange={(e) => setEditTitleTemplate(e.target.value)}
                        placeholder="e.g. Fix bug in [component]"
                      />
                    </div>
                    <div className="ph-field">
                      <label htmlFor={`editDescription-${template.id}`}>Description</label>
                      <textarea
                        id={`editDescription-${template.id}`}
                        rows={3}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                      />
                    </div>
                    <div className="ph-field">
                      <label htmlFor={`editPriority-${template.id}`}>Priority</label>
                      <Select
                        id={`editPriority-${template.id}`}
                        value={editPriority}
                        onChange={(v) => setEditPriority(v as Task["priority"])}
                        options={PRIORITIES.map((p) => ({ value: p, label: p }))}
                      />
                    </div>
                    <div className="ph-field">
                      <label>Default labels</label>
                      {labelChips(editLabelIds, (id) => setEditLabelIds((prev) => toggleId(prev, id)))}
                    </div>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <button
                        type="button"
                        className="ph-button"
                        style={{ width: "auto" }}
                        disabled={savingEdit || !editName.trim() || !editTitleTemplate.trim()}
                        onClick={() => handleSaveEdit(template)}
                      >
                        {savingEdit ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        className="ph-button ph-button-secondary"
                        style={{ width: "auto" }}
                        onClick={cancelEdit}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <strong className="truncate">{template.name}</strong>
                      <span className={`ph-priority-dot ph-priority-${template.priority ?? "medium"}`} />
                    </div>
                    <div style={{ fontSize: "0.85rem", color: "var(--ph-muted)", marginTop: "0.2rem" }}>
                      Title: {template.titleTemplate}
                    </div>
                    {template.description && (
                      <div style={{ fontSize: "0.78rem", color: "var(--ph-muted)", marginTop: "0.15rem" }}>
                        {template.description}
                      </div>
                    )}
                    {template.defaultLabelIds.length > 0 && (
                      <div className="ph-task-card-meta" style={{ marginTop: "0.35rem" }}>
                        {template.defaultLabelIds.map((labelId) => {
                          const label = labels.find((l) => l.id === labelId);
                          if (!label) return null;
                          return (
                            <span key={labelId} className="ph-label-chip" style={{ background: label.color }}>
                              {label.name}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>

              {editingId !== template.id && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", alignItems: "flex-end" }}>
                  <div style={{ display: "flex", gap: "0.2rem" }}>
                    <button
                      type="button"
                      className="ph-icon-btn"
                      aria-label={`Edit ${template.name}`}
                      title="Edit template"
                      onClick={() => startEdit(template)}
                    >
                      <IconPencil size={16} />
                    </button>
                    <button
                      type="button"
                      className="ph-icon-btn"
                      aria-label={`Delete ${template.name}`}
                      title="Delete this template"
                      onClick={() => setConfirmingDeleteId(template.id)}
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                  {confirmingDeleteId === template.id && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", alignItems: "flex-end" }}>
                      <span
                        style={{ fontSize: "0.75rem", color: "var(--ph-error)", maxWidth: "220px", textAlign: "right" }}
                      >
                        Delete "{template.name}"? This cannot be undone.
                      </span>
                      <div style={{ display: "flex", gap: "0.3rem" }}>
                        <button
                          type="button"
                          className="ph-remove-btn"
                          style={{ border: "1px solid var(--ph-error)" }}
                          onClick={() => handleDelete(template.id)}
                        >
                          Yes, delete
                        </button>
                        <button
                          type="button"
                          className="ph-button ph-button-secondary"
                          style={{ width: "auto" }}
                          onClick={() => setConfirmingDeleteId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {createError && (
        <div className="ph-alert ph-alert-error" style={{ marginTop: "0.75rem" }}>
          {createError}
        </div>
      )}

      <form onSubmit={handleCreate} style={{ marginTop: "1rem" }}>
        <div className="ph-field">
          <label htmlFor="newTemplateName">Name</label>
          <input id="newTemplateName" value={newName} onChange={(e) => setNewName(e.target.value)} required />
        </div>
        <div className="ph-field">
          <label htmlFor="newTemplateTitle">Task title</label>
          <input
            id="newTemplateTitle"
            value={newTitleTemplate}
            onChange={(e) => setNewTitleTemplate(e.target.value)}
            placeholder="e.g. Fix bug in [component]"
            required
          />
        </div>
        <div className="ph-field">
          <label htmlFor="newTemplateDescription">Description</label>
          <textarea
            id="newTemplateDescription"
            rows={3}
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
          />
        </div>
        <div className="ph-field">
          <label htmlFor="newTemplatePriority">Priority</label>
          <Select
            id="newTemplatePriority"
            value={newPriority}
            onChange={(v) => setNewPriority(v as Task["priority"])}
            options={PRIORITIES.map((p) => ({ value: p, label: p }))}
          />
        </div>
        <div className="ph-field">
          <label>Default labels</label>
          {labelChips(newLabelIds, (id) => setNewLabelIds((prev) => toggleId(prev, id)))}
        </div>
        <button
          className="ph-button"
          type="submit"
          disabled={creating || !newName.trim() || !newTitleTemplate.trim()}
          style={{ marginTop: "0.5rem", width: "auto" }}
        >
          {creating ? "Creating..." : "Create task template"}
        </button>
      </form>
    </div>
  );
}
