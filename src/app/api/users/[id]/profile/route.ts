import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { derivePermissions } from "@/lib/permissions";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // Get requestor profile
  const { data: requestor } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("clerk_user_id", userId)
    .single();

  if (!requestor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: targetId } = await params;

  // Get target profile
  const { data: target } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("clerk_user_id", targetId)
    .single();

  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Check permission to impersonate
  const isAdmin = requestor.role === "admin";
  const isGM = requestor.role === "general_manager";
  const isManager = requestor.role === "manager";

  const canImpersonate =
    isAdmin ||
    (isGM && target.location === requestor.location) ||
    (isManager && target.manager_id === requestor.clerk_user_id);

  if (!canImpersonate) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const permissions = derivePermissions(target);

  return NextResponse.json({ profile: target, permissions });
}
