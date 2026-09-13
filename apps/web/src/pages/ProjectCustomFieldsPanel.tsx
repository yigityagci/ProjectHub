import { useEffect, useState, type FormEvent } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CUSTOM_FIELD_TYPES, type CustomFieldType } from "@projecthub/shared";
import { api, ApiError } from "../lib/api.js";
import { IconGrip, IconPencil, IconTrash } from "../components/Icons.js";
import Select from "../components/Select.js";

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

const SELECT_TYPES = new Set<CustomFieldType>(["select", "multi_select"]);

function typeLabel(type: CustomFieldType): string {
  return type.replace("_", " ");
}

/**
 * Strips blank entries from a draft options list before it's sent to the
 * server — the add/remove option editor below always keeps at least one
 * (possibly empty) input visible so users have somewhere to type, but an
 * empty string is never a valid option value server-side.
 */
function cleanOptions(options: string[]): string[] {
  return options.map((o) => o.trim()).filter((o) => o.length > 0);
}

/**
 * Project Settings' "Custom fields" management panel: create/edit/reorder/
 * delete the typed field DEFINITIONS available to every task in this
 * project. Per-task VALUES are edited in TaskDetailModal, not here — this
 * panel only ever touches `{projectBase}/custom-fields[...]`.
 *
 * Callers must gate rendering this component on the `custom_field.manage`
 * role set themselves (see ProjectSettingsPage.tsx) — this component does
 * not re-check the caller's role, matching how RegistrationTokensPanel.tsx
 * is only ever mounted by an already-gated parent.
 */
export default function ProjectCustomFieldsPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const base = `/api/workspaces/${workspaceId}/projects/${projectId}/custom-fields`;

  const [fields, setFields] = useState<CustomFieldDefinition[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<CustomFieldType>("text");
  const [newOptions, setNewOptions] = useState<string[]>([""]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editOptions, setEditOptions] = useState<string[]>([""]);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  async function load() {
    setListError(null);
    try {
      const res = await api.get<{ fields: CustomFieldDefinition[] }>(base);
      setFields(res.fields.slice().sort((a, b) => a.position - b.position));
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Could not load custom fields.");
      setFields([]);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId]);

  const isNewTypeSelectLike = SELECT_TYPES.has(newType);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const res = await api.post<{ field: CustomFieldDefinition }>(base, {
        name: newName.trim(),
        type: newType,
        ...(isNewTypeSelectLike ? { options: cleanOptions(newOptions) } : {}),
      });
      setFields((prev) => [...(prev ?? []), res.field]);
      setNewName("");
      setNewType("text");
      setNewOptions([""]);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create this custom field.");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(field: CustomFieldDefinition) {
    setEditingFieldId(field.id);
    setEditName(field.name);
    setEditOptions(field.options.length > 0 ? field.options.slice() : [""]);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingFieldId(null);
    setEditError(null);
  }

  async function handleSaveEdit(field: CustomFieldDefinition) {
    setEditError(null);
    setSavingEdit(true);
    try {
      const isSelectType = SELECT_TYPES.has(field.type);
      const body: { name: string; options?: string[] } = { name: editName.trim() };
      if (isSelectType) {
        body.options = cleanOptions(editOptions);
      }
      const res = await api.patch<{ field: CustomFieldDefinition }>(`${base}/${field.id}`, body);
      setFields((prev) => (prev ?? []).map((f) => (f.id === field.id ? res.field : f)));
      setEditingFieldId(null);
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : "Could not update this custom field.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete(fieldId: string) {
    setDeleteError(null);
    try {
      await api.delete(`${base}/${fieldId}`);
      setFields((prev) => (prev ?? []).filter((f) => f.id !== fieldId));
      setConfirmingDeleteId(null);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete this custom field.");
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (!fields) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = fields.findIndex((f) => f.id === active.id);
    const newIndex = fields.findIndex((f) => f.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const previous = fields;
    const reordered = arrayMove(fields, oldIndex, newIndex);
    setFields(reordered);
    try {
      const res = await api.post<{ fields: CustomFieldDefinition[] }>(`${base}/reorder`, {
        fieldIds: reordered.map((f) => f.id),
      });
      setFields(res.fields.slice().sort((a, b) => a.position - b.position));
    } catch (err) {
      setFields(previous);
      setListError(err instanceof ApiError ? err.message : "Could not reorder custom fields.");
    }
  }

  return (
    <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
      <h1 style={{ fontSize: "1rem" }}>Custom fields</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Define extra typed fields (text, number, date, select, and more) that every task in this project can carry
        a value for. A field's type is fixed once created — delete and recreate it to change the type.
      </p>

      {listError && <div className="ph-alert ph-alert-error">{listError}</div>}
      {deleteError && <div className="ph-alert ph-alert-error">{deleteError}</div>}

      {fields === null ? (
        <p>Loading...</p>
      ) : fields.length === 0 ? (
        <div className="ph-empty-state">No custom fields defined yet.</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            <ul className="ph-assignee-list">
              {fields.map((field) => (
                <CustomFieldRow
                  key={field.id}
                  field={field}
                  editing={editingFieldId === field.id}
                  editName={editName}
                  editOptions={editOptions}
                  editError={editError}
                  savingEdit={savingEdit}
                  confirmingDelete={confirmingDeleteId === field.id}
                  onStartEdit={() => startEdit(field)}
                  onCancelEdit={cancelEdit}
                  onEditNameChange={setEditName}
                  onEditOptionChange={(index, value) =>
                    setEditOptions((prev) => prev.map((o, i) => (i === index ? value : o)))
                  }
                  onAddEditOption={() => setEditOptions((prev) => [...prev, ""])}
                  onRemoveEditOption={(index) => setEditOptions((prev) => prev.filter((_, i) => i !== index))}
                  onSaveEdit={() => handleSaveEdit(field)}
                  onRequestDelete={() => setConfirmingDeleteId(field.id)}
                  onCancelDelete={() => setConfirmingDeleteId(null)}
                  onConfirmDelete={() => handleDelete(field.id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {createError && (
        <div className="ph-alert ph-alert-error" style={{ marginTop: "0.75rem" }}>
          {createError}
        </div>
      )}

      <form onSubmit={handleCreate} style={{ marginTop: "1rem" }}>
        <div className="ph-field">
          <label htmlFor="newCustomFieldName">Name</label>
          <input id="newCustomFieldName" value={newName} onChange={(e) => setNewName(e.target.value)} required />
        </div>
        <div className="ph-field">
          <label htmlFor="newCustomFieldType">Type</label>
          <Select
            id="newCustomFieldType"
            value={newType}
            onChange={(v) => setNewType(v as CustomFieldType)}
            options={CUSTOM_FIELD_TYPES.map((t) => ({ value: t, label: typeLabel(t) }))}
          />
        </div>
        {isNewTypeSelectLike && (
          <div className="ph-field">
            <label>Options</label>
            {newOptions.map((opt, i) => (
              <div key={i} style={{ display: "flex", gap: "0.4rem", marginBottom: "0.35rem" }}>
                <input
                  value={opt}
                  onChange={(e) => setNewOptions((prev) => prev.map((o, idx) => (idx === i ? e.target.value : o)))}
                  placeholder={`Option ${i + 1}`}
                  aria-label={`Option ${i + 1}`}
                />
                {newOptions.length > 1 && (
                  <button
                    type="button"
                    className="ph-remove-btn"
                    onClick={() => setNewOptions((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="ph-button ph-button-secondary"
              style={{ width: "auto" }}
              onClick={() => setNewOptions((prev) => [...prev, ""])}
            >
              Add option
            </button>
          </div>
        )}
        <button
          className="ph-button"
          type="submit"
          disabled={creating || !newName.trim() || (isNewTypeSelectLike && cleanOptions(newOptions).length === 0)}
          style={{ marginTop: "0.5rem", width: "auto" }}
        >
          {creating ? "Creating..." : "Create custom field"}
        </button>
      </form>
    </div>
  );
}

function CustomFieldRow({
  field,
  editing,
  editName,
  editOptions,
  editError,
  savingEdit,
  confirmingDelete,
  onStartEdit,
  onCancelEdit,
  onEditNameChange,
  onEditOptionChange,
  onAddEditOption,
  onRemoveEditOption,
  onSaveEdit,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  field: CustomFieldDefinition;
  editing: boolean;
  editName: string;
  editOptions: string[];
  editError: string | null;
  savingEdit: boolean;
  confirmingDelete: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onEditNameChange: (value: string) => void;
  onEditOptionChange: (index: number, value: string) => void;
  onAddEditOption: () => void;
  onRemoveEditOption: (index: number) => void;
  onSaveEdit: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  // One `useSortable` per row, exactly mirroring KanbanBoardPage's column-
  // reorder pattern (BoardColumnShell) but simpler: the whole row (minus a
  // dedicated grip handle) is the sortable node, and there is no nested
  // sortable list inside a single custom-field row (unlike a board column,
  // which nests its own task-card SortableContext).
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    alignItems: "flex-start" as const,
  };
  const isSelectType = SELECT_TYPES.has(field.type);

  return (
    <li ref={setNodeRef} style={style}>
      <button
        type="button"
        className="ph-icon-btn ph-column-drag-handle"
        aria-label={`Reorder ${field.name}`}
        title="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <IconGrip size={16} />
      </button>

      <div style={{ flex: 1, minWidth: 0, margin: "0 0.5rem" }}>
        {editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {editError && <div className="ph-alert ph-alert-error">{editError}</div>}
            <input
              value={editName}
              onChange={(e) => onEditNameChange(e.target.value)}
              aria-label={`Name for ${field.name}`}
            />
            {isSelectType && (
              <div>
                {editOptions.map((opt, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.4rem", marginBottom: "0.35rem" }}>
                    <input
                      value={opt}
                      onChange={(e) => onEditOptionChange(i, e.target.value)}
                      placeholder={`Option ${i + 1}`}
                      aria-label={`Option ${i + 1} for ${field.name}`}
                    />
                    {editOptions.length > 1 && (
                      <button type="button" className="ph-remove-btn" onClick={() => onRemoveEditOption(i)}>
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="ph-button ph-button-secondary"
                  style={{ width: "auto" }}
                  onClick={onAddEditOption}
                >
                  Add option
                </button>
              </div>
            )}
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <button
                type="button"
                className="ph-button"
                style={{ width: "auto" }}
                disabled={
                  savingEdit || !editName.trim() || (isSelectType && cleanOptions(editOptions).length === 0)
                }
                onClick={onSaveEdit}
              >
                {savingEdit ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                className="ph-button ph-button-secondary"
                style={{ width: "auto" }}
                onClick={onCancelEdit}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <strong className="truncate">{field.name}</strong>
              <span className="ph-badge">{typeLabel(field.type)}</span>
            </div>
            {isSelectType && (
              <div style={{ fontSize: "0.78rem", color: "var(--ph-muted)", marginTop: "0.2rem" }}>
                {field.options.length > 0 ? `Options: ${field.options.join(", ")}` : "No options defined."}
              </div>
            )}
          </>
        )}
      </div>

      {!editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", alignItems: "flex-end" }}>
          <div style={{ display: "flex", gap: "0.2rem" }}>
            <button
              type="button"
              className="ph-icon-btn"
              aria-label={`Edit ${field.name}`}
              title="Edit name/options"
              onClick={onStartEdit}
            >
              <IconPencil size={16} />
            </button>
            <button
              type="button"
              className="ph-icon-btn"
              aria-label={`Delete ${field.name}`}
              title="Delete this field"
              onClick={onRequestDelete}
            >
              <IconTrash size={16} />
            </button>
          </div>
          {confirmingDelete && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", alignItems: "flex-end" }}>
              <span style={{ fontSize: "0.75rem", color: "var(--ph-error)", maxWidth: "220px", textAlign: "right" }}>
                Delete "{field.name}"? This also deletes every task's stored value for it. This cannot be undone.
              </span>
              <div style={{ display: "flex", gap: "0.3rem" }}>
                <button
                  type="button"
                  className="ph-remove-btn"
                  style={{ border: "1px solid var(--ph-error)" }}
                  onClick={onConfirmDelete}
                >
                  Yes, delete
                </button>
                <button
                  type="button"
                  className="ph-button ph-button-secondary"
                  style={{ width: "auto" }}
                  onClick={onCancelDelete}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
