import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/errorMessage";
import { derivePermissions } from "@/lib/permissions";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { data: profile, error } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("clerk_user_id", userId)
    .maybeSingle();

  // A database error is not "no access": report it as a server error so the
  // client can retry instead of telling an admin they lack permission.
  if (error) {
    console.error("[auth/me] Profile lookup failed:", error);
    return NextResponse.json({ error: `Couldn't load your profile: ${errorMessage(error)}` }, { status: 500 });
  }
  if (!profile) {
    return NextResponse.json({ error: "No profile found" }, { status: 403 });
  }

  const permissions = derivePermissions(profile);

  return NextResponse.json({ profile, permissions });
}
