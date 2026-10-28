import { useEffect, useState } from "react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRouter } from "next/navigation";
import { TeamMemberSelect } from "./TeamMemberSelect";
import { HelpTip } from "./HelpTip";

type UserRole = "admin" | "general_manager" | "manager" | "user";

interface UserProfile {
  clerk_user_id: string;
  email: string;
  full_name: string;
  role: UserRole;
  location: string | null;
  department: string | null;
  team_member_name: string | null;
  manager_id: string | null;
  created_at: string;
  manager?: { full_name: string; email: string } | null;
}

const ROLES: UserRole[] = ["admin", "general_manager", "manager", "user"];
const LOCATIONS = ["Utah", "Georgia"];
const DEPARTMENTS = ["design", "preservation", "fulfillment"];

// Returns true if the current user has strictly higher rank than the target
function outranks(currentRole: UserRole | undefined, targetRole: UserRole): boolean {
  if (!currentRole) return false;
  return ROLES.indexOf(currentRole) < ROLES.indexOf(targetRole);
}

const roleLabel = (role: UserRole) => {
  if (role === "general_manager") return "General Manager";
  if (role === "admin") return "Admin";
  if (role === "manager") return "Manager";
  return "User";
};

const roleBadgeColor = (role: UserRole) => {
  if (role === "admin") return "bg-red-100 text-red-700";
  if (role === "general_manager") return "bg-purple-100 text-purple-700";
  if (role === "manager") return "bg-blue-100 text-blue-700";
  return "bg-gray-100 text-gray-600";
};

export default function UserManagementPage() {
  const { user, startImpersonating, realUser } = useCurrentUser();
  const router = useRouter();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteFullName, setInviteFullName] = useState("");
  const [inviteRole, setInviteRole] = useState<UserRole>("user");
  const [inviteLocation, setInviteLocation] = useState("");
  const [inviteDepartment, setInviteDepartment] = useState("");
  const [inviteTeamMemberName, setInviteTeamMemberName] = useState("");
  const [inviteManagerId, setInviteManagerId] = useState("");

  const fetchUsers = async () => {
    setLoading(true);
    const res = await fetch("/api/users");
    const data = await res.json();
    setUsers(data.users ?? []);
    setLoading(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  const sendInvite = async () => {
    setError(null);
    setSaving(true);
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: inviteEmail,
        full_name: inviteFullName,
        role: inviteRole,
        location: inviteLocation || null,
        department: inviteDepartment || null,
        team_member_name: inviteTeamMemberName || null,
        manager_id: inviteManagerId || null,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error); return; }
    setInviteSent(true);
    setShowInviteForm(false);
    setInviteEmail(""); setInviteFullName(""); setInviteRole("user");
    setInviteLocation(""); setInviteDepartment(""); setInviteTeamMemberName(""); setInviteManagerId("");
    setTimeout(() => setInviteSent(false), 4000);
  };

  const saveEdit = async () => {
    if (!editingUser) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/users/${editingUser.clerk_user_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: editingUser.role,
        location: editingUser.location,
        department: editingUser.department,
        team_member_name: editingUser.team_member_name,
        manager_id: editingUser.manager_id,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error); return; }
    setEditingUser(null);
    fetchUsers();
  };

  const deleteUser = async (id: string) => {
    if (!confirm("Remove this user? They will lose access immediately.")) return;
    await fetch(`/api/users/${id}`, { method: "DELETE" });
    fetchUsers();
  };

  const handleImpersonate = async (target: UserProfile) => {
    try {
      await startImpersonating(target.clerk_user_id);
      // Small delay to ensure sessionStorage is written before navigation
      await new Promise(resolve => setTimeout(resolve, 200));
      if (target.role === "user") {
        window.location.replace("/my-dashboard");
      } else {
        window.location.replace("/dashboard");
      }
    } catch (err: any) {
      setError(err.message ?? "Could not impersonate user");
    }
  };

  if (!user?.permissions.canManageUsers) {
    return <div className="p-8 text-gray-500">You don't have permission to view this page.</div>;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900"><HelpTip id="team.title">Team Access</HelpTip></h1>
          <p className="text-sm text-gray-500 mt-1">{users.length} registered user{users.length !== 1 ? "s" : ""}</p>
        </div>
        <button
          onClick={() => setShowInviteForm(true)}
          className="px-4 py-2 bg-[#703C2E] text-white text-sm font-medium rounded-lg hover:bg-[#5a3025] transition-colors"
        >
          + Invite User
        </button>
      </div>

      {inviteSent && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
          Invite sent successfully!
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Invite Form */}
      {showInviteForm && (
        <div className="mb-6 p-5 bg-white border border-gray-200 rounded-xl shadow-sm">
          <h2 className="text-base font-semibold text-gray-900 mb-4"><HelpTip id="team.invite">Invite New User</HelpTip></h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Full Name *</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#703C2E]/30"
                placeholder="Emily Johnson"
                value={inviteFullName}
                onChange={e => setInviteFullName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email *</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#703C2E]/30"
                placeholder="emily@pressedfloral.com"
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Role *</label>
              <select
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#703C2E]/30"
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value as UserRole)}
              >
                {ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Location</label>
              <select
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#703C2E]/30"
                value={inviteLocation}
                onChange={e => setInviteLocation(e.target.value)}
              >
                <option value="">— None —</option>
                {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Department</label>
              <select
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#703C2E]/30"
                value={inviteDepartment}
                onChange={e => setInviteDepartment(e.target.value)}
              >
                <option value="">— None —</option>
                {DEPARTMENTS.map(d => <option key={d} value={d} className="capitalize">{d}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Schedule Name</label>
              <TeamMemberSelect
                value={inviteTeamMemberName}
                onChange={setInviteTeamMemberName}
                location={inviteLocation}
                department={inviteDepartment}
              />
              <p className="text-xs text-gray-400 mt-1">Must match their name in the scheduling system exactly.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Manager</label>
              <select
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#703C2E]/30"
                value={inviteManagerId}
                onChange={e => setInviteManagerId(e.target.value)}
              >
                <option value="">— None —</option>
                {users.filter(u => ["admin","general_manager","manager"].includes(u.role)).map(u => (
                  <option key={u.clerk_user_id} value={u.clerk_user_id}>{u.full_name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={sendInvite}
              disabled={saving || !inviteEmail || !inviteFullName}
              className="px-4 py-2 bg-[#703C2E] text-white text-sm font-medium rounded-lg hover:bg-[#5a3025] disabled:opacity-50 transition-colors"
            >
              {saving ? "Sending..." : "Send Invite"}
            </button>
            <button
              onClick={() => setShowInviteForm(false)}
              className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-base font-semibold text-gray-900 mb-4">Edit {editingUser.full_name}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
                <select
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={editingUser.role}
                  onChange={e => setEditingUser({ ...editingUser, role: e.target.value as UserRole })}
                >
                  {ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Location</label>
                <select
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={editingUser.location ?? ""}
                  onChange={e => setEditingUser({ ...editingUser, location: e.target.value || null })}
                >
                  <option value="">— None —</option>
                  {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Department</label>
                <select
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={editingUser.department ?? ""}
                  onChange={e => setEditingUser({ ...editingUser, department: e.target.value || null })}
                >
                  <option value="">— None —</option>
                  {DEPARTMENTS.map(d => <option key={d} value={d} className="capitalize">{d}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Schedule Name</label>
                <input
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={editingUser.team_member_name ?? ""}
                  onChange={e => setEditingUser({ ...editingUser, team_member_name: e.target.value || null })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Manager</label>
                <select
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={editingUser.manager_id ?? ""}
                  onChange={e => setEditingUser({ ...editingUser, manager_id: e.target.value || null })}
                >
                  <option value="">— None —</option>
                  {users.filter(u => u.clerk_user_id !== editingUser.clerk_user_id && ["admin","general_manager","manager"].includes(u.role)).map(u => (
                    <option key={u.clerk_user_id} value={u.clerk_user_id}>{u.full_name}</option>
                  ))}
                </select>
              </div>
            </div>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <div className="flex gap-3 mt-5">
              <button
                onClick={saveEdit}
                disabled={saving}
                className="px-4 py-2 bg-[#703C2E] text-white text-sm font-medium rounded-lg hover:bg-[#5a3025] disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
              <button
                onClick={() => setEditingUser(null)}
                className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Users Table */}
      {loading ? (
        <div className="text-sm text-gray-400 py-8 text-center">Loading users...</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide"><HelpTip id="team.role">Role</HelpTip></th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide"><HelpTip id="team.location">Location</HelpTip></th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Department</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide"><HelpTip id="team.manager">Manager</HelpTip></th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide"><HelpTip id="team.scheduleName">Schedule Name</HelpTip></th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr key={u.clerk_user_id} className={i % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{u.full_name}</div>
                    <div className="text-xs text-gray-400">{u.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${roleBadgeColor(u.role)}`}>
                      {roleLabel(u.role)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{u.location ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{u.department ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{u.manager?.full_name ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{u.team_member_name ?? "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setEditingUser(u)}
                        className="text-xs px-3 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        Edit
                      </button>
                      {u.clerk_user_id !== realUser?.profile.clerk_user_id &&
                       outranks(user?.profile.role as UserRole, u.role) && (
                        <button
                          onClick={() => handleImpersonate(u)}
                          className="text-xs px-3 py-1 rounded-lg border border-amber-200 text-amber-600 hover:bg-amber-50 transition-colors"
                        >
                          View as
                        </button>
                      )}
                      {u.clerk_user_id !== realUser?.profile.clerk_user_id &&
                       outranks(user?.profile.role as UserRole, u.role) && (
                        <button
                          onClick={() => deleteUser(u.clerk_user_id)}
                          className="text-xs px-3 py-1 rounded-lg border border-red-100 text-red-500 hover:bg-red-50 transition-colors"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
