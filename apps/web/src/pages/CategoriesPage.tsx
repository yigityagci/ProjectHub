import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import NotificationBell from "../components/NotificationBell.js";
import ThemeToggle from "../components/ThemeToggle.js";
import { IconPlus } from "../components/Icons.js";
import type { CurrentUser } from "../App.js";

interface Category {
  id: string;
  projectId: string;
  name: string;
  visibility: "workspace" | "private";
}

interface ProjectMember {
  userId: string;
  email: string;
  displayName: string;
  addedAt: string;
}

interface WorkspaceRosterMember {
  userId: string;
  email: string;
  displayName: string;
}

interface Milestone {
  id: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  completedAt: string | null;
}

// Mirrors CAN_CREATE_PROJECT_ROLES/CAN_MANAGE_BOARD_ROLES's frontend-gating
// convention (packages/shared/src/roles.ts's `category.manage` grant) —
// these are UX affordance gates only, the real security boundary is the
// backend guard chain (requireCategoryAccess + requirePermission). This
// same role set also happens to match `project.members.manage`'s grantees
// (OWNER/ADMIN/PROJECT_MANAGER), so it's reused as-is for the "Project
// members" panel below rather than declaring an equivalent duplicate.
const CAN_MANAGE_CATEGORY_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);

// Mirrors `milestone.manage`'s grant in DEFAULT_ROLE_PERMISSIONS
// (OWNER/ADMIN/PROJECT_MANAGER) — UX affordance only, the real boundary is
// requirePermission("milestone.manage") server-side. Everyone with project
// access (any role reaching this page at all) can still view the list;
// this only gates create/complete/delete.
const CAN_MANAGE_MILESTONES_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);

/**
 * Category picker: the project-level landing page a project card now links
 * to (instead of a board directly — see docs/PHASES.md, Option A two-step
 * creation UX). Lists categories the caller can see (the server already
 * access-filters, mirroring how the project list never leaks private
 * projects today), each linking to that category's own board.
 */
export default function CategoriesPage({ user }: { user: CurrentUser }) {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const navigate = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [projectVisibility, setProjectVisibility] = useState<"workspace" | "private" | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryVisibility, setNewCategoryVisibility] = useState<"workspace" | "private">("workspace");
  const [error, setError] = useState<string | null>(null);

  // Project members panel (private projects only, managers only) — see
  // below near the JSX render for the visibility+permission gate.
  const [projectMembers, setProjectMembers] = useState<ProjectMember[] | null>(null);
  const [workspaceRoster, setWorkspaceRoster] = useState<WorkspaceRosterMember[]>([]);
  const [projectMembersError, setProjectMembersError] = useState<string | null>(null);
  const [selectedNewMemberId, setSelectedNewMemberId] = useState("");
  const [addingMember, setAddingMember] = useState(false);

  // Milestones panel — fetched in its own effect, parallel to categories,
  // same pattern as the project-members panel above. Visible to anyone with
  // project access; create/toggle/delete are gated separately below.
  const [milestones, setMilestones] = useState<Milestone[] | null>(null);
  const [milestonesError, setMilestonesError] = useState<string | null>(null);
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [newMilestoneName, setNewMilestoneName] = useState("");
  const [newMilestoneDescription, setNewMilestoneDescription] = useState("");
  const [newMilestoneTargetDate, setNewMilestoneTargetDate] = useState("");
  const [creatingMilestone, setCreatingMilestone] = useState(false);

  async function load() {
    if (!workspaceId || !projectId) return;
    try {
      const ws = await api.get<{ role: string }>(`/api/workspaces/${workspaceId}`);
      setRole(ws.role);

      const projectRes = await api.get<{ project: { name: string; visibility: "workspace" | "private" } }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}`,
      );
      setProjectName(projectRes.project.name);
      setProjectVisibility(projectRes.project.visibility);

      const res = await api.get<{ categories: Category[] }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories`,
      );
      setCategories(res.categories);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate(`/workspace/${workspaceId}/projects`);
        return;
      }
      setCategories([]);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId]);

  const canManageCategories = role !== null && CAN_MANAGE_CATEGORY_ROLES.has(role);
  const showProjectMembersPanel = projectVisibility === "private" && canManageCategories;

  async function loadProjectMembersPanel() {
    if (!workspaceId || !projectId) return;
    setProjectMembersError(null);
    try {
      const [membersRes, rosterRes] = await Promise.all([
        api.get<{ members: ProjectMember[] }>(
          `/api/workspaces/${workspaceId}/projects/${projectId}/members`,
        ),
        api.get<{ members: WorkspaceRosterMember[] }>(`/api/workspaces/${workspaceId}/members`),
      ]);
      setProjectMembers(membersRes.members);
      setWorkspaceRoster(rosterRes.members);
    } catch (err) {
      setProjectMembersError(
        err instanceof ApiError ? err.message : "Could not load this project's members.",
      );
      setProjectMembers([]);
    }
  }

  useEffect(() => {
    if (showProjectMembersPanel) {
      loadProjectMembersPanel().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId, showProjectMembersPanel]);

  async function handleAddProjectMember(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId || !projectId || !selectedNewMemberId) return;
    setProjectMembersError(null);
    setAddingMember(true);
    try {
      await api.post(`/api/workspaces/${workspaceId}/projects/${projectId}/members`, {
        userId: selectedNewMemberId,
      });
      setSelectedNewMemberId("");
      await loadProjectMembersPanel();
    } catch (err) {
      setProjectMembersError(
        err instanceof ApiError ? err.message : "Could not add this member to the project.",
      );
    } finally {
      setAddingMember(false);
    }
  }

  async function handleRemoveProjectMember(userId: string) {
    if (!workspaceId || !projectId) return;
    setProjectMembersError(null);
    try {
      await api.delete(`/api/workspaces/${workspaceId}/projects/${projectId}/members/${userId}`);
      setProjectMembers((prev) => (prev ?? []).filter((m) => m.userId !== userId));
    } catch (err) {
      setProjectMembersError(
        err instanceof ApiError ? err.message : "Could not remove this member from the project.",
      );
    }
  }

  async function loadMilestones() {
    if (!workspaceId || !projectId) return;
    setMilestonesError(null);
    try {
      const res = await api.get<{ milestones: Milestone[] }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      );
      setMilestones(res.milestones);
    } catch (err) {
      setMilestonesError(err instanceof ApiError ? err.message : "Could not load this project's milestones.");
      setMilestones([]);
    }
  }

  useEffect(() => {
    loadMilestones().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId]);

  const canManageMilestones = role !== null && CAN_MANAGE_MILESTONES_ROLES.has(role);

  async function handleCreateMilestone(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId || !projectId) return;
    const name = newMilestoneName.trim();
    if (!name) return;
    setMilestonesError(null);
    setCreatingMilestone(true);
    try {
      await api.post(`/api/workspaces/${workspaceId}/projects/${projectId}/milestones`, {
        name,
        ...(newMilestoneDescription.trim() ? { description: newMilestoneDescription.trim() } : {}),
        ...(newMilestoneTargetDate ? { targetDate: newMilestoneTargetDate } : {}),
      });
      setNewMilestoneName("");
      setNewMilestoneDescription("");
      setNewMilestoneTargetDate("");
      setAddingMilestone(false);
      await loadMilestones();
    } catch (err) {
      setMilestonesError(err instanceof ApiError ? err.message : "Could not create this milestone.");
    } finally {
      setCreatingMilestone(false);
    }
  }

  async function handleToggleMilestone(milestone: Milestone) {
    if (!workspaceId || !projectId) return;
    setMilestonesError(null);
    try {
      const res = await api.patch<{ milestone: Milestone }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestone.id}`,
        { completedAt: milestone.completedAt ? null : new Date().toISOString() },
      );
      setMilestones((prev) =>
        (prev ?? []).map((m) => (m.id === milestone.id ? res.milestone : m)),
      );
    } catch (err) {
      setMilestonesError(err instanceof ApiError ? err.message : "Could not update this milestone.");
    }
  }

  async function handleDeleteMilestone(milestoneId: string) {
    if (!workspaceId || !projectId) return;
    setMilestonesError(null);
    try {
      await api.delete(`/api/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}`);
      setMilestones((prev) => (prev ?? []).filter((m) => m.id !== milestoneId));
    } catch (err) {
      setMilestonesError(err instanceof ApiError ? err.message : "Could not delete this milestone.");
    }
  }

  const addableRosterMembers = workspaceRoster.filter(
    (m) => !(projectMembers ?? []).some((pm) => pm.userId === m.userId),
  );

  async function handleCreateCategory(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId || !projectId) return;
    const name = newCategoryName.trim();
    if (!name) return;
    setError(null);
    setCreating(true);
    try {
      const res = await api.post<{ category: Category }>(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories`,
        { name, visibility: newCategoryVisibility },
      );
      setNewCategoryName("");
      setNewCategoryVisibility("workspace");
      setAddingCategory(false);
      await load();
      // Go straight into the freshly-created category's board — the same
      // "create then immediately enter" flow the forced first-category
      // step uses (see NewCategoryPage.tsx), just optional here.
      navigate(`/workspace/${workspaceId}/projects/${projectId}/categories/${res.category.id}/board`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setCreating(false);
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
        <div className="ph-breadcrumb-row">
          <Link
            className="ph-button ph-button-secondary"
            style={{ width: "auto", textDecoration: "none" }}
            to={`/workspace/${workspaceId}/projects`}
          >
            <span aria-hidden="true">‹</span> Back to Projects
          </Link>
          <div className="ph-breadcrumb">
            <Link to="/">Your workspaces</Link> /{" "}
            <Link to={`/workspace/${workspaceId}/projects`}>Projects</Link> / {projectName || "..."}
          </div>
        </div>

        <div className="ph-page-header">
          <div>
            <h1>Categories</h1>
            <p className="ph-subtitle" style={{ margin: 0 }}>
              Each category is its own working board within {projectName || "this project"}.
            </p>
          </div>
          {/* canManageCategories also mirrors project.edit's grant (same
              OWNER/ADMIN/PROJECT_MANAGER set as category.manage), so it is
              reused here rather than declaring an equivalent duplicate. */}
          {canManageCategories && (
            <Link
              className="ph-button ph-button-secondary"
              style={{ width: "auto", textDecoration: "none" }}
              to={`/workspace/${workspaceId}/projects/${projectId}/settings`}
            >
              Settings
            </Link>
          )}
        </div>

        {showProjectMembersPanel && (
          <div className="ph-card ph-card-wide" style={{ marginBottom: "1.5rem" }}>
            <h1 style={{ fontSize: "1rem" }}>Project members</h1>
            <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
              This project is private — only these members (and managers) can see it.
            </p>
            {projectMembersError && <div className="ph-alert ph-alert-error">{projectMembersError}</div>}
            {projectMembers === null ? (
              <p>Loading...</p>
            ) : projectMembers.length === 0 ? (
              <div className="ph-empty-state">No explicit project members yet.</div>
            ) : (
              <ul className="ph-assignee-list">
                {projectMembers.map((m) => (
                  <li key={m.userId}>
                    <span className="truncate" title={m.email}>
                      {m.displayName} ({m.email})
                    </span>
                    <button
                      type="button"
                      className="ph-remove-btn"
                      onClick={() => handleRemoveProjectMember(m.userId)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="ph-inline-form"
              style={{ marginTop: "0.75rem" }}
              onSubmit={handleAddProjectMember}
            >
              <div className="ph-field">
                <label htmlFor="newProjectMember">Add a workspace member</label>
                <select
                  id="newProjectMember"
                  value={selectedNewMemberId}
                  onChange={(e) => setSelectedNewMemberId(e.target.value)}
                >
                  <option value="">Select a member...</option>
                  {addableRosterMembers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.displayName} ({m.email})
                    </option>
                  ))}
                </select>
              </div>
              <button className="ph-button" type="submit" disabled={addingMember || !selectedNewMemberId}>
                {addingMember ? "Adding..." : "Add"}
              </button>
            </form>
          </div>
        )}

        <div className="ph-card ph-card-wide" style={{ marginBottom: "1.5rem" }}>
          <h1 style={{ fontSize: "1rem" }}>Milestones</h1>
          {milestonesError && <div className="ph-alert ph-alert-error">{milestonesError}</div>}
          {milestones === null ? (
            <p>Loading...</p>
          ) : milestones.length === 0 ? (
            <div className="ph-empty-state">No milestones yet.</div>
          ) : (
            <ul className="ph-assignee-list">
              {milestones.map((m) => (
                <li key={m.id}>
                  <label
                    className="ph-task-complete-toggle"
                    style={{ margin: 0, flex: 1, minWidth: 0 }}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(m.completedAt)}
                      disabled={!canManageMilestones}
                      onChange={() => handleToggleMilestone(m)}
                      aria-label={m.completedAt ? "Mark milestone as not done" : "Mark milestone as done"}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", minWidth: 0 }}>
                      <span className="truncate" title={m.name}>
                        {m.name}
                      </span>
                      <span style={{ fontSize: "0.78rem", color: "var(--ph-muted)" }}>
                        {m.targetDate ? `Due ${new Date(m.targetDate).toLocaleDateString()}` : "No target date"}
                        {m.completedAt ? ` · Completed ${new Date(m.completedAt).toLocaleDateString()}` : ""}
                      </span>
                    </div>
                  </label>
                  {canManageMilestones && (
                    <button
                      type="button"
                      className="ph-remove-btn"
                      onClick={() => handleDeleteMilestone(m.id)}
                    >
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canManageMilestones &&
            (addingMilestone ? (
              <form
                className="ph-inline-form"
                style={{ marginTop: "0.75rem", flexWrap: "wrap" }}
                onSubmit={handleCreateMilestone}
              >
                <div className="ph-field">
                  <label htmlFor="newMilestoneName">Name</label>
                  <input
                    id="newMilestoneName"
                    value={newMilestoneName}
                    onChange={(e) => setNewMilestoneName(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div className="ph-field">
                  <label htmlFor="newMilestoneDescription">Description (optional)</label>
                  <input
                    id="newMilestoneDescription"
                    value={newMilestoneDescription}
                    onChange={(e) => setNewMilestoneDescription(e.target.value)}
                  />
                </div>
                <div className="ph-field">
                  <label htmlFor="newMilestoneTargetDate">Target date (optional)</label>
                  <input
                    id="newMilestoneTargetDate"
                    type="date"
                    value={newMilestoneTargetDate}
                    onChange={(e) => setNewMilestoneTargetDate(e.target.value)}
                  />
                </div>
                <button
                  className="ph-button"
                  type="submit"
                  disabled={creatingMilestone || !newMilestoneName.trim()}
                >
                  {creatingMilestone ? "Adding..." : "Add milestone"}
                </button>
                <button
                  type="button"
                  className="ph-button ph-button-secondary"
                  onClick={() => {
                    setAddingMilestone(false);
                    setNewMilestoneName("");
                    setNewMilestoneDescription("");
                    setNewMilestoneTargetDate("");
                  }}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="ph-button ph-button-secondary"
                style={{ marginTop: "0.75rem", width: "auto" }}
                onClick={() => setAddingMilestone(true)}
              >
                <IconPlus size={15} />
                Add milestone
              </button>
            ))}
        </div>

        {categories === null ? (
          <p>Loading...</p>
        ) : categories.length === 0 ? (
          <div className="ph-empty-state">
            {canManageCategories ? (
              // A permitted (rank-elevated) caller sees every category in
              // this project regardless of visibility (same rule as
              // requireCategoryAccess's elevated-rank escape hatch) — so an
              // empty list for THIS caller unambiguously means the project
              // really does have zero categories, never "categories exist
              // but I can't see them." Safe to offer the creation CTA here.
              <>
                <p style={{ margin: "0 0 0.75rem" }}>
                  This project has no categories yet — create the first one to start building its board.
                </p>
                <button
                  type="button"
                  className="ph-button"
                  style={{ width: "auto" }}
                  onClick={() =>
                    navigate(`/workspace/${workspaceId}/projects/${projectId}/categories/new?first=true`)
                  }
                >
                  Create the first category
                </button>
              </>
            ) : (
              // A non-privileged caller cannot tell (and must not be able
              // to tell) whether this project genuinely has zero
              // categories, or has categories that are simply all private
              // and invisible to them — the API deliberately returns the
              // same empty array either way to avoid leaking a private
              // category's existence. Show the safe, non-leaking copy and
              // offer no action.
              "You don't have access to any categories in this project yet."
            )}
          </div>
        ) : (
          <ul className="ph-category-list">
            {categories.map((c) => (
              <li key={c.id}>
                <Link
                  className="ph-category-card gap-3"
                  to={`/workspace/${workspaceId}/projects/${projectId}/categories/${c.id}/board`}
                >
                  <span className="min-w-0 truncate" title={c.name}>
                    {c.name}
                  </span>
                  <span className="ph-category-card-meta shrink-0">
                    {c.visibility === "private" && <span className="ph-badge ph-badge-private">Private</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {canManageCategories && categories !== null && categories.length > 0 && (
          <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
            {addingCategory ? (
              <>
                <h1 style={{ fontSize: "1rem" }}>New category</h1>
                {error && <div className="ph-alert ph-alert-error">{error}</div>}
                <form onSubmit={handleCreateCategory}>
                  <div className="ph-field">
                    <label htmlFor="catName">Category name</label>
                    <input
                      id="catName"
                      value={newCategoryName}
                      onChange={(e) => setNewCategoryName(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                  <div className="ph-field">
                    <label htmlFor="catVisibility">Visibility</label>
                    <select
                      id="catVisibility"
                      value={newCategoryVisibility}
                      onChange={(e) => setNewCategoryVisibility(e.target.value as "workspace" | "private")}
                    >
                      <option value="workspace">Workspace — visible to every project member</option>
                      <option value="private">Private — only category members and managers</option>
                    </select>
                  </div>
                  <div style={{ display: "flex", gap: "0.6rem" }}>
                    <button
                      className="ph-button"
                      style={{ width: "auto" }}
                      type="submit"
                      disabled={creating || !newCategoryName.trim()}
                    >
                      {creating ? "Creating..." : "Create category"}
                    </button>
                    <button
                      type="button"
                      className="ph-button ph-button-secondary"
                      style={{ width: "auto" }}
                      onClick={() => {
                        setAddingCategory(false);
                        setNewCategoryName("");
                        setError(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <button
                type="button"
                className="ph-button ph-button-secondary"
                onClick={() => setAddingCategory(true)}
              >
                <IconPlus size={15} />
                New category
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
