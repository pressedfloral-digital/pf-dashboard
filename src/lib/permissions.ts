// The one place that turns a user's role + location into what they can see
// and do. Used by /api/auth/me (the signed-in user) and
// /api/users/[id]/profile (impersonation), so both always agree.
//
// Roles:
//   admin            everything, both locations
//   general_manager  view both locations; edit their own location
//   manager          view and edit their own location
//   user             Department Dashboard only; no CPO
//   viewer           read-only, both locations; no Scorecards/KPIs, no CPO

export type Role = 'admin' | 'general_manager' | 'manager' | 'user' | 'viewer';

export interface Permissions {
  canEditUtah: boolean;
  canEditGeorgia: boolean;
  canViewUtah: boolean;
  canViewGeorgia: boolean;
  canViewCPO: boolean;
  canManageUsers: boolean;
  canViewAllLocations: boolean;
  canEditSchedule: boolean;
  canEditHistoricals: boolean;
  /** Scheduling, Inventory and Growth & Distribution tabs. */
  canViewScheduling: boolean;
  /** Scorecards and All KPIs tabs. */
  canViewScorecards: boolean;
  isUserRole: boolean;
  isViewerRole: boolean;
}

export function derivePermissions(profile: { role: string | null; location: string | null }): Permissions {
  const { role, location } = profile;
  const isAdmin   = role === 'admin';
  const isGM      = role === 'general_manager';
  const isManager = role === 'manager';
  const isUser    = role === 'user';
  const isViewer  = role === 'viewer';
  const isStaff   = isAdmin || isGM || isManager;
  const editsHere = (loc: string) => isAdmin || ((isGM || isManager) && location === loc);
  const viewsHere = (loc: string) => isAdmin || isGM || isViewer || ((isManager || isUser) && location === loc);

  return {
    canEditUtah:         editsHere('Utah'),
    canEditGeorgia:      editsHere('Georgia'),
    canViewUtah:         viewsHere('Utah'),
    canViewGeorgia:      viewsHere('Georgia'),
    canViewCPO:          isStaff,
    canManageUsers:      isStaff,
    canViewAllLocations: isAdmin || isGM || isViewer,
    canEditSchedule:     isStaff,
    canEditHistoricals:  isStaff,
    canViewScheduling:   isStaff || isViewer,
    canViewScorecards:   isStaff,
    isUserRole:          isUser,
    isViewerRole:        isViewer,
  };
}
