import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/errorMessage';
import { derivePermissions, type Permissions } from '@/lib/permissions';

// Server-side half of the role rules in permissions.ts. Hiding a button in
// the UI doesn't stop a request, so every route that changes data (or
// returns pay) loads the caller's access here and checks it before acting.

export interface Access {
  userId:      string;
  role:        string | null;
  location:    string | null;
  name:        string | null;
  permissions: Permissions;
}

/**
 * The signed-in caller's role, location and permissions, or the error
 * response to return as-is (401 not signed in, 403 no profile, 500 lookup
 * failed). Usage:
 *
 *   const access = await getAccess();
 *   if (access instanceof NextResponse) return access;
 */
export async function getAccess(): Promise<Access | NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('user_profiles')
    .select('role, location, full_name')
    .eq('clerk_user_id', userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: `Couldn't load your profile: ${errorMessage(error)}` }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'No dashboard profile found for your account' }, { status: 403 });

  const role     = (data.role as string | null) ?? null;
  const location = (data.location as string | null) ?? null;
  return {
    userId,
    role,
    location,
    name: (data.full_name as string | null) ?? null,
    permissions: derivePermissions({ role, location }),
  };
}

/** A 403 with a message the dashboard can show as-is. */
export function forbidden(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 403 });
}
