import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Manager/GM pay (surfaced as CPO on the schedule) is only visible to that
// person themself, their manager and up the chain, or a GM/admin who
// oversees their location — never to peer managers or other locations.
const MAX_CHAIN_DEPTH = 10;

type MgrProfile = { clerk_user_id: string; team_member_name: string | null; role: string; location: string | null; manager_id: string | null };

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { data: requestor } = await supabase
    .from("user_profiles")
    .select("clerk_user_id, role, location")
    .eq("clerk_user_id", userId)
    .single();

  if (!requestor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (requestor.role === "admin") {
    return NextResponse.json({ all: true, names: [] });
  }
  if (requestor.role !== "general_manager" && requestor.role !== "manager") {
    return NextResponse.json({ all: false, names: [] });
  }

  const { data: mgrs, error } = await supabase
    .from("user_profiles")
    .select("clerk_user_id, team_member_name, role, location, manager_id")
    .in("role", ["manager", "general_manager"]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const byId = new Map((mgrs as MgrProfile[] ?? []).map(m => [m.clerk_user_id, m]));

  function requestorIsAncestorOf(m: MgrProfile): boolean {
    let curManagerId = m.manager_id;
    for (let i = 0; i < MAX_CHAIN_DEPTH && curManagerId; i++) {
      if (curManagerId === requestor!.clerk_user_id) return true;
      curManagerId = byId.get(curManagerId)?.manager_id ?? null;
    }
    return false;
  }

  const names = new Set<string>();
  (mgrs as MgrProfile[] ?? []).forEach(m => {
    if (!m.team_member_name) return;
    const isSelf = m.clerk_user_id === requestor.clerk_user_id;
    const gmSameLocation = requestor.role === "general_manager" && m.location === requestor.location;
    if (isSelf || gmSameLocation || requestorIsAncestorOf(m)) {
      names.add(m.team_member_name);
    }
  });

  return NextResponse.json({ all: false, names: Array.from(names) });
}
