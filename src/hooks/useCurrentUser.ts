import { useEffect, useState, useCallback } from "react";
import type { Role as UserRole, Permissions as UserPermissions } from "@/lib/permissions";

export type { UserRole };

export interface UserProfile {
  clerk_user_id: string;
  email: string;
  full_name: string;
  role: UserRole;
  location: string | null;
  department: string | null;
  team_member_name: string | null;
  manager_id: string | null;
  invited_by: string | null;
  created_at: string;
}

export type { UserPermissions };

interface CurrentUser {
  profile: UserProfile;
  permissions: UserPermissions;
}

interface UseCurrentUserResult {
  user: CurrentUser | null;
  realUser: CurrentUser | null;
  loading: boolean;
  error: string | null;
  isImpersonating: boolean;
  startImpersonating: (targetId: string) => Promise<void>;
  stopImpersonating: () => void;
  /** Re-request the profile after a failed load. */
  retry: () => void;
}

const IMPERSONATION_KEY = "pf_impersonating_id";

interface LoadedUser {
  realUser: CurrentUser;
  impersonatedUser: CurrentUser | null;
}

// One shared request for the whole page: every component that calls
// useCurrentUser() gets the same answer, so one section can't show "no
// permission" while the rest of the page loaded fine.
let shared: Promise<LoadedUser> | null = null;

class ProfileError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

async function fetchMe(): Promise<CurrentUser> {
  // 403 = no profile (a real answer); 5xx and network failures are retried.
  for (let attempt = 0; ; attempt++) {
    let error: ProfileError;
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (res.ok) return await res.json();
      const body = await res.json().catch(() => null) as { error?: string } | null;
      error = new ProfileError(body?.error ?? `Failed to load user profile (HTTP ${res.status})`, res.status >= 500);
    } catch (e) {
      error = new ProfileError(e instanceof Error ? e.message : "Network error", true);
    }
    if (!error.retryable || attempt >= 2) throw error;
    await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
  }
}

async function loadUser(): Promise<LoadedUser> {
  const realUser = await fetchMe();
  let impersonatedUser: CurrentUser | null = null;
  const impersonatingId = localStorage.getItem(IMPERSONATION_KEY);
  if (impersonatingId) {
    try {
      const res = await fetch(`/api/users/${impersonatingId}/profile`);
      if (res.ok) impersonatedUser = await res.json();
      else localStorage.removeItem(IMPERSONATION_KEY);
    } catch {
      localStorage.removeItem(IMPERSONATION_KEY);
    }
  }
  return { realUser, impersonatedUser };
}

function sharedUser(): Promise<LoadedUser> {
  if (!shared) {
    shared = loadUser();
    // A failed load isn't cached: the next caller (or Retry) tries again.
    shared.catch(() => { shared = null; });
  }
  return shared;
}

export function useCurrentUser(): UseCurrentUserResult {
  const [realUser, setRealUser] = useState<CurrentUser | null>(null);
  const [impersonatedUser, setImpersonatedUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    sharedUser()
      .then(({ realUser, impersonatedUser }) => {
        if (cancelled) return;
        setRealUser(realUser);
        setImpersonatedUser(impersonatedUser);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setAttempt(a => a + 1);
  }, []);

  const startImpersonating = useCallback(async (targetId: string) => {
    const res = await fetch(`/api/users/${targetId}/profile`);
    if (!res.ok) throw new Error("Cannot impersonate this user");
    const data = await res.json();
    localStorage.setItem(IMPERSONATION_KEY, targetId);
    shared = null;
    setImpersonatedUser(data);
  }, []);

  const stopImpersonating = useCallback(() => {
    localStorage.removeItem(IMPERSONATION_KEY);
    shared = null;
    setImpersonatedUser(null);
    window.location.href = "/dashboard";
  }, []);

  const isImpersonating = impersonatedUser !== null;
  const user = isImpersonating ? impersonatedUser : realUser;

  return {
    user,
    realUser,
    loading,
    error,
    isImpersonating,
    startImpersonating,
    stopImpersonating,
    retry,
  };
}
