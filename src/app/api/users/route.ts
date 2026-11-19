import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { getAccess, forbidden } from "@/lib/routeAccess";
import { inviteDenied } from "@/lib/userManagement";
import { errorMessage } from "@/lib/errorMessage";

// GET /api/users — list all users (admins, GMs, managers)
export async function GET() {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;
  if (!access.permissions.canManageUsers) return forbidden("You don't have access to Team Access");

  const { data: users, error } = await supabase
    .from("user_profiles")
    .select("*, manager:manager_id(full_name, email)")
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ users });
}

// POST /api/users — invite a new user. Admins: anyone. GMs and managers:
// their own location, at the roles in lib/userManagement.ts.
export async function POST(req: Request) {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;
  const { userId } = access;

  const body = await req.json();
  const { email, full_name, role, location, department, team_member_name, manager_id } = body;

  if (!email || !full_name || !role) {
    return NextResponse.json({ error: "email, full_name, and role are required" }, { status: 400 });
  }
  const denied = inviteDenied(access, { role, location: location ?? null });
  if (denied) return forbidden(denied);
  try {
    const clerk = await clerkClient();
    await clerk.invitations.createInvitation({
      emailAddress: email,
      redirectUrl: "https://ops.pressedfloral.com/sign-up",
      publicMetadata: {
        full_name,
        role,
        location: location ?? null,
        department: department ?? null,
        team_member_name: team_member_name ?? null,
        manager_id: manager_id ?? null,
        invited_by: userId,
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Invite error:", err);
    return NextResponse.json({ error: errorMessage(err) || "Failed to send invite" }, { status: 500 });
  }
}
