import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { DESIGNER_IDS } from "@/lib/teamMembers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ROSTER_KEYS = ["designRoster", "presRoster", "ffRoster", "resinRoster"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

type Entry = Record<string, unknown> & { id?: unknown; personId?: unknown };

// PUT /api/my-dashboard/availability
// Body: { memberName?, location?, department?, entries }
// Replaces the caller's own availability entries (Add availability on the team
// view) and leaves everyone else's in the location's `unavailability` list
// untouched. Explicit member params are only honoured for admins/GMs/managers
// ("View as") or when they match the caller's own profile — same rule as GET
// /api/my-dashboard.
export async function PUT(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const body = await req.json() as { memberName?: string; location?: string; department?: string; entries?: unknown };
  if (!Array.isArray(body.entries)) return NextResponse.json({ error: "entries required" }, { status: 400 });

  const { data: caller } = await supabase
    .from("user_profiles")
    .select("role, team_member_name, location, department")
    .eq("clerk_user_id", userId)
    .single();
  if (!caller) return NextResponse.json({ error: "No profile" }, { status: 403 });

  let memberName: string | null = caller.team_member_name;
  let location: string | null = caller.location;
  if (body.memberName && body.location && body.department) {
    const isPrivileged = ["admin", "general_manager", "manager"].includes(caller.role ?? "");
    const isOwnData =
      caller.team_member_name === body.memberName &&
      caller.location === body.location &&
      caller.department === body.department;
    if (!isPrivileged && !isOwnData) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    memberName = body.memberName;
    location = body.location;
  }
  if (!memberName || !location) return NextResponse.json({ error: "No schedule name on profile" }, { status: 403 });

  // Same home-location override as GET, so we write the list the view read
  const { data: emp } = await supabase
    .from("rippling_employees")
    .select("location")
    .ilike("full_name", memberName.trim())
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (emp?.location) location = emp.location;

  // The caller's ids: every roster entry under their name, plus the legacy design id
  const { data: rosterRows } = await supabase
    .from("schedule_settings")
    .select("key, value")
    .eq("location", location)
    .in("key", ROSTER_KEYS);
  const nameLower = memberName.trim().toLowerCase();
  const ownIds = new Set<string>();
  if (DESIGNER_IDS[memberName]) ownIds.add(DESIGNER_IDS[memberName]);
  for (const row of rosterRows ?? []) {
    let roster: unknown;
    try { roster = typeof row.value === "string" ? JSON.parse(row.value) : row.value; } catch { continue; }
    for (const [key, m] of Object.entries((roster ?? {}) as Record<string, { id?: string; name?: string; _removed?: boolean }>)) {
      if (!m || m._removed || m.name?.trim().toLowerCase() !== nameLower) continue;
      ownIds.add(m.id ?? key);
    }
  }
  if (ownIds.size === 0) return NextResponse.json({ error: "Not on a roster" }, { status: 403 });

  const entries: Entry[] = [];
  for (const raw of body.entries as Entry[]) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.personId !== "string") {
      return NextResponse.json({ error: "Invalid entry" }, { status: 400 });
    }
    if (!ownIds.has(raw.personId)) return NextResponse.json({ error: "Entry is for someone else" }, { status: 403 });
    const e = raw as Record<string, unknown>;
    if (e.kind !== "unavailable" && e.kind !== "preferred") return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
    if (typeof e.date !== "string" || !ISO_DATE.test(e.date)) return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    if (e.repeat !== "none" && e.repeat !== "weekly") return NextResponse.json({ error: "Invalid repeat" }, { status: 400 });
    if (!e.allDay && (typeof e.start !== "string" || typeof e.end !== "string" || !HHMM.test(e.start) || !HHMM.test(e.end))) {
      return NextResponse.json({ error: "Invalid time" }, { status: 400 });
    }
    entries.push({
      id: e.id, personId: e.personId, personName: memberName,
      kind: e.kind, date: e.date, repeat: e.repeat,
      weekdays: Array.isArray(e.weekdays) ? e.weekdays.filter(d => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) : undefined,
      until: typeof e.until === "string" && ISO_DATE.test(e.until) ? e.until : undefined,
      skip: Array.isArray(e.skip) ? e.skip.filter(d => typeof d === "string" && ISO_DATE.test(d)) : undefined,
      allDay: !!e.allDay,
      start: e.allDay ? undefined : e.start, end: e.allDay ? undefined : e.end,
      note: typeof e.note === "string" && e.note.trim() ? e.note.trim().slice(0, 200) : undefined,
      createdAt: typeof e.createdAt === "string" ? e.createdAt : new Date().toISOString(),
    });
  }

  const { data: current } = await supabase
    .from("schedule_settings")
    .select("value")
    .eq("location", location)
    .eq("key", "unavailability")
    .maybeSingle();
  let list: Entry[] = [];
  try {
    const v = typeof current?.value === "string" ? JSON.parse(current.value) : current?.value;
    if (Array.isArray(v)) list = v;
  } catch { /* treat as empty */ }

  const next = [...list.filter(e => typeof e?.personId !== "string" || !ownIds.has(e.personId)), ...entries];
  const { error } = await supabase
    .from("schedule_settings")
    .upsert(
      { location, key: "unavailability", value: next, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: "location,key" }
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ unavailability: entries });
}
