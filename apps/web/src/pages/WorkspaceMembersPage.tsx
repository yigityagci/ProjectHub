import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ROLE_KEYS, ROLE_RANK, ROLE_DISPLAY_NAME, type RoleKey } from "@projecthub/shared";
import { Brand } from "../App.js";
import { api, ApiError } from "../lib/api.js";
import NotificationBell from "../components/NotificationBell.js";
import ThemeToggle from "../components/ThemeToggle.js";
import type { CurrentUser } from "../App.js";

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  joinedAt: string;
}

interface Invitation {
  id: string;
  email: string;
  roleKey: string;
  roleName: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

// These three role-gate sets mirror ProjectsPage's CAN_CREATE_PROJECT_ROLES /
// CategoriesPage's CAN_MANAGE_CATEGORY_ROLES convention exactly — they are
// UX affordance gates only, the real security boundary is the backend guard
// chain (requirePermission("member.invite" | "role.manage" | "member.remove"),
// and the dual member.invite-OR-role.manage inline check on the invitations
// list/revoke routes). Each mirrors a DIFFERENT permission grant from
// packages/shared/src/roles.ts's DEFAULT_ROLE_PERMISSIONS, so they are kept
// as three separate sets rather than collapsed into one.
const CAN_INVITE_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);
const CAN_MANAGE_ROLES_ROLES = new Set(["OWNER", "ADMIN"]);
const CAN_REMOVE_MEMBER_ROLES = new Set(["OWNER", "ADMIN"]);

// Mirrors `workspace.settings.manage`'s grant in DEFAULT_ROLE_PERMISSIONS
// (OWNER/ADMIN only — PROJECT_MANAGER does not have it) — UX affordance
// only, the real boundary is requirePermission("workspace.settings.manage")
// server-side. Kept separate from CAN_MANAGE_ROLES_ROLES even though the
// role sets are identical today, since they mirror different permissions.
const CAN_MANAGE_WORKSPACE_SETTINGS_ROLES = new Set(["OWNER", "ADMIN"]);

/** Roles the caller (holding `ownRoleKey`) may assign to someone else —
 * soft-filters `<select>` options to the caller's own rank or below, mirroring
 * assertCanAssignRole's server-side invariant (the server remains the
 * authority; this is purely a UX nicety). */
function assignableRoles(ownRoleKey: string | null): RoleKey[] {
  if (!ownRoleKey || !(ROLE_KEYS as readonly string[]).includes(ownRoleKey)) return [];
  const ownRank = ROLE_RANK[ownRoleKey as RoleKey];
  return ROLE_KEYS.filter((key) => ROLE_RANK[key] <= ownRank);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

export default function WorkspaceMembersPage({ user }: { user: CurrentUser }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();

  const [workspaceName, setWorkspaceName] = useState("");
  const [role, setRole] = useState<string | null>(null);

  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSuccess, setRenameSuccess] = useState<string | null>(null);

  const [members, setMembers] = useState<Member[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);

  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<RoleKey>("MEMBER");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  async function loadWorkspace() {
    if (!workspaceId) return;
    try {
      const ws = await api.get<{ workspace: { name: string }; role: string }>(
        `/api/workspaces/${workspaceId}`,
      );
      setWorkspaceName(ws.workspace.name);
      setRole(ws.role);
      setRenameName(ws.workspace.name);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate("/");
        return;
      }
    }
  }

  async function loadMembers() {
    if (!workspaceId) return;
    setMembersError(null);
    try {
      const res = await api.get<{ members: Member[] }>(`/api/workspaces/${workspaceId}/members`);
      setMembers(res.members);
    } catch (err) {
      setMembersError(err instanceof ApiError ? err.message : "Could not load members.");
      setMembers([]);
    }
  }

  async function loadInvitations() {
    if (!workspaceId) return;
    setInvitationsError(null);
    try {
      const res = await api.get<{ invitations: Invitation[] }>(
        `/api/workspaces/${workspaceId}/invitations`,
      );
      setInvitations(res.invitations);
    } catch (err) {
      setInvitationsError(err instanceof ApiError ? err.message : "Could not load pending invitations.");
      setInvitations([]);
    }
  }

  // Fetched in parallel, independent effects: a failure in one section never
  // blocks the other from rendering.
  useEffect(() => {
    loadWorkspace().catch(() => undefined);
    loadMembers().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const canViewInvitations = role !== null && (CAN_INVITE_ROLES.has(role) || CAN_MANAGE_ROLES_ROLES.has(role));

  useEffect(() => {
    if (canViewInvitations) {
      loadInvitations().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, canViewInvitations]);

  const canInvite = role !== null && CAN_INVITE_ROLES.has(role);
  const canManageRoles = role !== null && CAN_MANAGE_ROLES_ROLES.has(role);
  const canRemoveMember = role !== null && CAN_REMOVE_MEMBER_ROLES.has(role);
  const canRevokeInvitation = canInvite || canManageRoles;
  const canManageWorkspaceSettings = role !== null && CAN_MANAGE_WORKSPACE_SETTINGS_ROLES.has(role);

  async function handleRename(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setRenameError(null);
    setRenameSuccess(null);
    setRenaming(true);
    try {
      const res = await api.patch<{ workspace: { name: string } }>(`/api/workspaces/${workspaceId}`, {
        name: renameName,
      });
      setWorkspaceName(res.workspace.name);
      setRenameName(res.workspace.name);
      setRenameSuccess("Workspace renamed.");
    } catch (err) {
      setRenameError(err instanceof ApiError ? err.message : "Could not rename this workspace.");
    } finally {
      setRenaming(false);
    }
  }

  const ownerCount = (members ?? []).filter((m) => m.role === "OWNER").length;
  const roleOptions = assignableRoles(role);
  const inviteRoleOptions = assignableRoles(role);

  async function handleRoleChange(member: Member, newRoleKey: string) {
    if (!workspaceId) return;
    setMembersError(null);
    try {
      const res = await api.patch<{ member: { userId: string; role: string } }>(
        `/api/workspaces/${workspaceId}/members/${member.userId}/role`,
        { roleKey: newRoleKey },
      );
      setMembers((prev) =>
        (prev ?? []).map((m) => (m.userId === member.userId ? { ...m, role: res.member.role } : m)),
      );
    } catch (err) {
      setMembersError(err instanceof ApiError ? err.message : "Could not update this member's role.");
    }
  }

  async function handleRemoveMember(member: Member) {
    if (!workspaceId) return;
    setMembersError(null);
    try {
      await api.delete(`/api/workspaces/${workspaceId}/members/${member.userId}`);
      setMembers((prev) => (prev ?? []).filter((m) => m.userId !== member.userId));
    } catch (err) {
      setMembersError(err instanceof ApiError ? err.message : "Could not remove this member.");
    }
  }

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setInviteError(null);
    setInviteSuccess(null);
    setInviting(true);
    try {
      const res = await api.post<{ invitation: { email: string } }>(
        `/api/workspaces/${workspaceId}/invitations`,
        { email: inviteEmail, roleKey: inviteRole },
      );
      setInviteSuccess(`Invitation sent to ${res.invitation.email}.`);
      setInviteEmail("");
      setInviteRole("MEMBER");
      await loadInvitations();
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setInviting(false);
    }
  }

  async function handleRevoke(invitation: Invitation) {
    if (!workspaceId) return;
    setInvitationsError(null);
    try {
      await api.post(`/api/workspaces/${workspaceId}/invitations/${invitation.id}/revoke`);
      setInvitations((prev) => (prev ?? []).filter((i) => i.id !== invitation.id));
    } catch (err) {
      setInvitationsError(err instanceof ApiError ? err.message : "Could not revoke this invitation.");
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
          <Link to={`/workspace/${workspaceId}/projects`}>{workspaceName || "..."}</Link> / Members
        </div>

        <div className="ph-page-header">
          <div>
            <h1>Members</h1>
            <p className="ph-subtitle" style={{ margin: 0 }}>
              Invite members and manage their roles in this workspace.
            </p>
          </div>
        </div>

        {canManageWorkspaceSettings && (
          <div className="ph-card ph-card-wide" style={{ marginBottom: "1.5rem" }}>
            <h1 style={{ fontSize: "1rem" }}>Workspace settings</h1>
            {renameError && <div className="ph-alert ph-alert-error">{renameError}</div>}
            {renameSuccess && <div className="ph-alert ph-alert-success">{renameSuccess}</div>}
            <form onSubmit={handleRename}>
              <div className="ph-field">
                <label htmlFor="workspaceName">Workspace name</label>
                <input
                  id="workspaceName"
                  value={renameName}
                  onChange={(e) => setRenameName(e.target.value)}
                  required
                />
              </div>
              <button
                className="ph-button"
                type="submit"
                disabled={renaming || !renameName.trim() || renameName.trim() === workspaceName}
              >
                {renaming ? "Saving..." : "Save name"}
              </button>
            </form>
          </div>
        )}

        <div className="ph-card ph-card-wide">
          <h1 style={{ fontSize: "1rem" }}>Active members</h1>
          {membersError && <div className="ph-alert ph-alert-error">{membersError}</div>}
          {members === null ? (
            <p>Loading...</p>
          ) : members.length === 0 ? (
            <div className="ph-empty-state">No members found.</div>
          ) : (
            <ul className="ph-assignee-list">
              {members.map((m) => {
                const isSelf = m.userId === user.id;
                const isSoleOwner = m.role === "OWNER" && ownerCount <= 1;
                return (
                  <li key={m.userId}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", minWidth: 0 }}>
                      <span className="truncate" title={m.email}>
                        {m.email}
                      </span>
                      <span style={{ fontSize: "0.78rem", color: "var(--ph-muted)" }}>
                        {m.displayName} · Joined {formatDate(m.joinedAt)}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexShrink: 0 }}>
                      {!isSelf && canManageRoles ? (
                        <select
                          aria-label={`Role for ${m.email}`}
                          value={m.role}
                          onChange={(e) => handleRoleChange(m, e.target.value)}
                        >
                          {/* Always include the member's current role, even if it
                              falls outside the caller's own assignable range, so
                              the select never silently misrepresents their role. */}
                          {!roleOptions.includes(m.role as RoleKey) && (
                            <option value={m.role}>{ROLE_DISPLAY_NAME[m.role as RoleKey] ?? m.role}</option>
                          )}
                          {roleOptions.map((key) => (
                            <option key={key} value={key}>
                              {ROLE_DISPLAY_NAME[key]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="ph-role-badge">{ROLE_DISPLAY_NAME[m.role as RoleKey] ?? m.role}</span>
                      )}
                      {!isSelf && canRemoveMember && (
                        <button
                          type="button"
                          className="ph-remove-btn"
                          disabled={isSoleOwner}
                          title={isSoleOwner ? "The last workspace owner cannot be removed." : undefined}
                          onClick={() => handleRemoveMember(m)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {canViewInvitations && (
          <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
            <h1 style={{ fontSize: "1rem" }}>Pending invitations</h1>
            {invitationsError && <div className="ph-alert ph-alert-error">{invitationsError}</div>}
            {invitations === null ? (
              <p>Loading...</p>
            ) : invitations.length === 0 ? (
              <div className="ph-empty-state">No pending invitations.</div>
            ) : (
              <ul className="ph-assignee-list">
                {invitations.map((inv) => (
                  <li key={inv.id}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", minWidth: 0 }}>
                      <span className="truncate" title={inv.email}>
                        {inv.email}
                      </span>
                      <span style={{ fontSize: "0.78rem", color: "var(--ph-muted)" }}>
                        {inv.roleName} · Expires {formatDate(inv.expiresAt)}
                      </span>
                    </div>
                    {canRevokeInvitation && (
                      <button type="button" className="ph-remove-btn" onClick={() => handleRevoke(inv)}>
                        Revoke
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {canInvite && (
          <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
            <h1 style={{ fontSize: "1rem" }}>Invite a member</h1>
            {inviteError && <div className="ph-alert ph-alert-error">{inviteError}</div>}
            {inviteSuccess && <div className="ph-alert ph-alert-success">{inviteSuccess}</div>}
            <form onSubmit={handleInvite}>
              <div className="ph-field">
                <label htmlFor="inviteEmail">Email</label>
                <input
                  id="inviteEmail"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                />
              </div>
              <div className="ph-field">
                <label htmlFor="inviteRole">Role</label>
                <select
                  id="inviteRole"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as RoleKey)}
                >
                  {inviteRoleOptions.map((key) => (
                    <option key={key} value={key}>
                      {ROLE_DISPLAY_NAME[key]}
                    </option>
                  ))}
                </select>
              </div>
              <button className="ph-button" type="submit" disabled={inviting || !inviteEmail.trim()}>
                {inviting ? "Sending..." : "Send invitation"}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
