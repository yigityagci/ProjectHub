import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PROJECT_STATUSES, PROJECT_VISIBILITIES, type ProjectStatus, type ProjectVisibility } from "@projecthub/shared";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import NotificationBell from "../components/NotificationBell.js";
import ThemeToggle from "../components/ThemeToggle.js";
import ProjectCustomFieldsPanel from "./ProjectCustomFieldsPanel.js";
import type { CurrentUser } from "../App.js";

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  visibility: ProjectVisibility;
  startDate: string | null;
  targetDate: string | null;
  archived: boolean;
  archivedAt: string | null;
}

// Mirrors `project.edit`/`project.archive`'s grant in DEFAULT_ROLE_PERMISSIONS
// (OWNER/ADMIN/PROJECT_MANAGER) — UX affordance only, the real boundary is
// requirePermission("project.edit" | "project.archive") server-side.
const CAN_EDIT_PROJECT_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);

// Mirrors `project.delete`'s grant — deliberately NOT the same set as above:
// PROJECT_MANAGER can edit/archive a project but cannot delete it.
const CAN_DELETE_PROJECT_ROLES = new Set(["OWNER", "ADMIN"]);

// Mirrors `custom_field.manage`'s grant — identical role set to
// `project.edit` above (see packages/shared/src/roles.ts), kept as its own
// named constant since the two permissions are independent server-side even
// though the default role grants happen to coincide (same convention as
// KanbanBoardPage.tsx's CAN_MANAGE_BOARD_ROLES/CAN_MANAGE_CATEGORY_ROLES).
const CAN_MANAGE_CUSTOM_FIELDS_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);

function toDateInputValue(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 10);
}

export default function ProjectSettingsPage({ user }: { user: CurrentUser }) {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const navigate = useNavigate();

  const [role, setRole] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("planning");
  const [visibility, setVisibility] = useState<ProjectVisibility>("workspace");
  const [startDate, setStartDate] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function load() {
    if (!workspaceId || !projectId) return;
    try {
      const ws = await api.get<{ role: string }>(`/api/workspaces/${workspaceId}`);
      setRole(ws.role);

      const res = await api.get<{ project: Project }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}`,
      );
      setProject(res.project);
      setName(res.project.name);
      setDescription(res.project.description ?? "");
      setStatus(res.project.status);
      setVisibility(res.project.visibility);
      setStartDate(toDateInputValue(res.project.startDate));
      setTargetDate(toDateInputValue(res.project.targetDate));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate(`/workspace/${workspaceId}/projects`);
        return;
      }
      setLoadError(true);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId]);

  const canEdit = role !== null && CAN_EDIT_PROJECT_ROLES.has(role);
  const canDelete = role !== null && CAN_DELETE_PROJECT_ROLES.has(role);
  const canManageCustomFields = role !== null && CAN_MANAGE_CUSTOM_FIELDS_ROLES.has(role);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId || !projectId) return;
    setSaveError(null);
    setSaveSuccess(null);
    setSaving(true);
    try {
      const res = await api.patch<{ project: Project }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}`,
        {
          name,
          description: description.trim() ? description.trim() : null,
          status,
          visibility,
          startDate: startDate ? startDate : null,
          targetDate: targetDate ? targetDate : null,
        },
      );
      setProject(res.project);
      setSaveSuccess("Project settings saved.");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  async function handleArchiveToggle() {
    if (!workspaceId || !projectId || !project) return;
    setArchiveError(null);
    setArchiveBusy(true);
    try {
      const action = project.archived ? "unarchive" : "archive";
      const res = await api.post<{ project: Project }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/${action}`,
      );
      setProject(res.project);
    } catch (err) {
      setArchiveError(
        err instanceof ApiError ? err.message : "Could not update this project's archive state.",
      );
    } finally {
      setArchiveBusy(false);
    }
  }

  async function handleDelete() {
    if (!workspaceId || !projectId || !project) return;
    if (confirmName.trim() !== project.name) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      await api.delete(`/api/workspaces/${workspaceId}/projects/${projectId}`);
      navigate(`/workspace/${workspaceId}/projects`);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete this project.");
      setDeleting(false);
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
        </div>
      </div>

      <div className="ph-page-wide">
        <div className="ph-breadcrumb">
          <Link to="/">Your workspaces</Link> /{" "}
          <Link to={`/workspace/${workspaceId}/projects`}>Projects</Link> /{" "}
          <Link to={`/workspace/${workspaceId}/projects/${projectId}/categories`}>
            {project?.name || "..."}
          </Link>{" "}
          / Settings
        </div>

        <div className="ph-page-header">
          <div>
            <h1>Project settings</h1>
            <p className="ph-subtitle" style={{ margin: 0 }}>
              Edit details, archive, or permanently delete this project.
            </p>
          </div>
        </div>

        {loadError && <div className="ph-alert ph-alert-error">Could not load this project.</div>}

        {!loadError && project === null ? (
          <p>Loading...</p>
        ) : !loadError && !canEdit && !canDelete && !canManageCustomFields ? (
          <div className="ph-empty-state">You don't have access to manage this project's settings.</div>
        ) : (
          !loadError &&
          project && (
            <>
              {canEdit && (
                <div className="ph-card ph-card-wide">
                  <h1 style={{ fontSize: "1rem" }}>Details</h1>
                  {saveError && <div className="ph-alert ph-alert-error">{saveError}</div>}
                  {saveSuccess && <div className="ph-alert ph-alert-success">{saveSuccess}</div>}
                  <form onSubmit={handleSave}>
                    <div className="ph-field">
                      <label htmlFor="projName">Project name</label>
                      <input id="projName" value={name} onChange={(e) => setName(e.target.value)} required />
                    </div>
                    <div className="ph-field">
                      <label htmlFor="projDescription">Description</label>
                      <textarea
                        id="projDescription"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={4}
                      />
                    </div>
                    <div className="ph-field">
                      <label htmlFor="projStatus">Status</label>
                      <select
                        id="projStatus"
                        value={status}
                        onChange={(e) => setStatus(e.target.value as ProjectStatus)}
                      >
                        {PROJECT_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s.replace("_", " ")}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="ph-field">
                      <label htmlFor="projVisibility">Visibility</label>
                      <select
                        id="projVisibility"
                        value={visibility}
                        onChange={(e) => setVisibility(e.target.value as ProjectVisibility)}
                      >
                        {PROJECT_VISIBILITIES.map((v) => (
                          <option key={v} value={v}>
                            {v === "workspace" ? "Workspace — visible to every workspace member" : "Private — only project members and managers"}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="ph-field">
                      <label htmlFor="projStartDate">Start date</label>
                      <input
                        id="projStartDate"
                        type="date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                      />
                    </div>
                    <div className="ph-field">
                      <label htmlFor="projTargetDate">Target date</label>
                      <input
                        id="projTargetDate"
                        type="date"
                        value={targetDate}
                        onChange={(e) => setTargetDate(e.target.value)}
                      />
                    </div>
                    <button className="ph-button" type="submit" disabled={saving || !name.trim()}>
                      {saving ? "Saving..." : "Save changes"}
                    </button>
                  </form>
                </div>
              )}

              {canEdit && (
                <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
                  <h1 style={{ fontSize: "1rem" }}>Archive</h1>
                  <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
                    {project.archived
                      ? "This project is archived. Unarchive it to make it active again."
                      : "Archiving hides this project from active use without deleting anything."}
                  </p>
                  {archiveError && <div className="ph-alert ph-alert-error">{archiveError}</div>}
                  <button
                    type="button"
                    className="ph-button ph-button-secondary"
                    style={{ width: "auto" }}
                    disabled={archiveBusy}
                    onClick={handleArchiveToggle}
                  >
                    {archiveBusy ? "Working..." : project.archived ? "Unarchive project" : "Archive project"}
                  </button>
                </div>
              )}

              {canManageCustomFields && workspaceId && projectId && (
                <ProjectCustomFieldsPanel workspaceId={workspaceId} projectId={projectId} />
              )}

              {canDelete && (
                <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
                  <h1 style={{ fontSize: "1rem" }}>Delete this project</h1>
                  <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
                    This permanently deletes the project and everything in it — categories, boards, tasks,
                    milestones, and labels. This cannot be undone.
                  </p>
                  {deleteError && <div className="ph-alert ph-alert-error">{deleteError}</div>}
                  {confirmingDelete ? (
                    <div>
                      <div className="ph-field">
                        <label htmlFor="confirmDeleteName">
                          Type <strong>{project.name}</strong> to confirm
                        </label>
                        <input
                          id="confirmDeleteName"
                          value={confirmName}
                          onChange={(e) => setConfirmName(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div style={{ display: "flex", gap: "0.6rem" }}>
                        <button
                          type="button"
                          className="ph-remove-btn"
                          style={{ border: "1px solid var(--ph-error)" }}
                          disabled={deleting || confirmName.trim() !== project.name}
                          onClick={handleDelete}
                        >
                          {deleting ? "Deleting..." : "Yes, permanently delete this project"}
                        </button>
                        <button
                          type="button"
                          className="ph-button ph-button-secondary"
                          style={{ width: "auto" }}
                          onClick={() => {
                            setConfirmingDelete(false);
                            setConfirmName("");
                            setDeleteError(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="ph-remove-btn"
                      style={{ border: "1px solid var(--ph-error)" }}
                      onClick={() => setConfirmingDelete(true)}
                    >
                      Delete this project
                    </button>
                  )}
                </div>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}
