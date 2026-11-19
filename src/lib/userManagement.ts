// Who can invite, edit and remove dashboard users (Team Access). Pure rules,
// used by the /api/users routes (enforced) and the Team Access page (so it
// only offers what will work).
//
//   admin            anyone, any role, any location
//   general_manager  people in their own location, as Manager / User / Viewer
//   manager          people in their own location, as User
//
// Nobody but an admin can change their own account, and non-admins can't
// touch anyone at or above the roles they're allowed to assign.

import type { Role } from './permissions';

export interface Actor {
  userId:   string;
  role:     string | null;
  location: string | null;
}

export interface TargetUser {
  clerk_user_id: string;
  role:          string | null;
  location:      string | null;
}

const ALL_ROLES: Role[] = ['admin', 'general_manager', 'manager', 'user', 'viewer'];

/** The roles this person may give someone (empty = can't manage users). */
export function assignableRoles(role: string | null): Role[] {
  if (role === 'admin')           return ALL_ROLES;
  if (role === 'general_manager') return ['manager', 'user', 'viewer'];
  if (role === 'manager')         return ['user'];
  return [];
}

/** Locations this person may put someone in; null = any (admins). */
export function assignableLocations(actor: Pick<Actor, 'role' | 'location'>): string[] | null {
  if (actor.role === 'admin') return null;
  return actor.location ? [actor.location] : [];
}

/** Why an invite isn't allowed, or null if it is. */
export function inviteDenied(actor: Actor, invite: { role: string; location: string | null }): string | null {
  const roles = assignableRoles(actor.role);
  if (roles.length === 0) return 'Only admins, general managers and managers can invite people';
  if (!roles.includes(invite.role as Role)) return `You can't invite someone as ${invite.role}`;
  const locs = assignableLocations(actor);
  if (locs && (!invite.location || !locs.includes(invite.location))) {
    return actor.location
      ? `You can only invite people to ${actor.location}`
      : 'Your account has no location, so you can only be given invite access by an admin';
  }
  return null;
}

/** Why this person can't edit or remove the target at all, or null. */
export function manageDenied(actor: Actor, target: TargetUser): string | null {
  if (actor.role === 'admin') return null;
  if (assignableRoles(actor.role).length === 0) return 'Only admins, general managers and managers can manage users';
  if (target.clerk_user_id === actor.userId) return 'Ask an admin to change your own account';
  if (!assignableRoles(actor.role).includes(target.role as Role)) return `You can't change a ${target.role ?? 'user'} account`;
  if (!actor.location || target.location !== actor.location) return `You can only manage people in ${actor.location ?? 'your location'}`;
  return null;
}

/** Why this edit isn't allowed, or null. */
export function editDenied(actor: Actor, target: TargetUser, updates: { role?: string; location?: string | null }): string | null {
  const denied = manageDenied(actor, target);
  if (denied || actor.role === 'admin') return denied;
  if (updates.role !== undefined && !assignableRoles(actor.role).includes(updates.role as Role)) {
    return `You can't make someone ${updates.role}`;
  }
  if (updates.location !== undefined && updates.location !== actor.location) {
    return `You can only keep people in ${actor.location}`;
  }
  return null;
}
