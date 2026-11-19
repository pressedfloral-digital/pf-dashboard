import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAccess, forbidden } from "@/lib/routeAccess";
import { editDenied, manageDenied, type TargetUser } from "@/lib/userManagement";

async function loadTarget(id: string): Promise<TargetUser | NextResponse> {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("clerk_user_id, role, location")
    .eq("clerk_user_id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "User not found" }, { status: 404 });
  return data as TargetUser;
}

// PATCH /api/users/[id] — update a user profile. Admins: anyone. GMs and
// managers: people in their own location, within the roles they can assign.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;

  const target = await loadTarget((await params).id);
  if (target instanceof NextResponse) return target;

  const body = await req.json();
  const { role, location, department, team_member_name, manager_id } = body;

  const denied = editDenied(access, target, { role, location });
  if (denied) return forbidden(denied);

  const updates: Record<string, unknown> = {};
  if (role !== undefined) updates.role = role;
  if (location !== undefined) updates.location = location;
  if (department !== undefined) updates.department = department;
  if (team_member_name !== undefined) updates.team_member_name = team_member_name;
  if (manager_id !== undefined) updates.manager_id = manager_id;

  const { error } = await supabase
    .from("user_profiles")
    .update(updates)
    .eq("clerk_user_id", target.clerk_user_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}

// DELETE /api/users/[id] — remove a user. Same who-can-manage-whom rules.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;

  const target = await loadTarget((await params).id);
  if (target instanceof NextResponse) return target;

  const denied = manageDenied(access, target);
  if (denied) return forbidden(denied);

  const { error } = await supabase
    .from("user_profiles")
    .delete()
    .eq("clerk_user_id", target.clerk_user_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
