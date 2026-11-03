import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/users — list all users (admin only)
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { data: requestor } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("clerk_user_id", userId)
    .single();

  if (!["admin", "general_manager", "manager"].includes(requestor?.role ?? "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: users, error } = await supabase
    .from("user_profiles")
    .select("*, manager:manager_id(full_name, email)")
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ users });
}

// POST /api/users — invite a new user (admin only)
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { data: requestor } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("clerk_user_id", userId)
    .single();

  if (requestor?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { email, full_name, role, location, department, team_member_name, manager_id } = body;

  if (!email || !full_name || !role) {
    return NextResponse.json({ error: "email, full_name, and role are required" }, { status: 400 });
  }

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
  } catch (err: any) {
    console.error("Invite error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to send invite" }, { status: 500 });
  }
}
