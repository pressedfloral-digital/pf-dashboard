/**
 * Finds the frames each designer designed in a week and picks the ones to
 * grade for Design Quality.
 *
 * A frame qualifies in the week it FIRST reached No Response
 * (`frameCompleted`) — that's the designer's first upload. A product that
 * goes back to No Response after a disapproval doesn't qualify again, so we
 * look back LOOKBACK_DAYS before the week to find each product's real first
 * time. Weeks run Monday–Sunday on the Utah (America/Denver) calendar, the
 * same way Historicals dates completed production (src/lib/production-counts.ts).
 *
 * Hours are total hours worked across every department that week, from the
 * Rippling upload (team_member_week_actuals).
 */
import { randomInt } from 'crypto';
import { pfGet } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';
import { canonicalStaffName } from '@/lib/production-counts';
import { canonicalAssignmentStaffName, normalizeAssignmentStaffName } from '@/lib/assignment-counts';
import { isNonProductionStaff } from '@/lib/nonProductionStaff';

const LOOKBACK_DAYS = 90;
const TZ = 'America/Denver';

export interface QualifyingFrame {
  orderNum: string;
  orderProductUuid: string;
  variantTitle: string | null;
  firstNoResponseAt: string;
}

export interface DesignerWeek {
  designerName: string;
  location: string | null;
  hours: number | null;
  frames: QualifyingFrame[];
}

interface CompletionEvent {
  uuid: string;
  orderProductUuid: string;
  orderNumber: string;
  variantTitle?: string | null;
  effectiveAt: string;
  status: string;
  staffName?: string | null;
}

export function isoAddDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function denverDate(ts: string): string {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
}

function staffDisplayName(raw: string): string {
  return canonicalAssignmentStaffName(canonicalStaffName(raw.trim()));
}

async function fetchFrameCompletedEvents(start: string, end: string): Promise<CompletionEvent[]> {
  const events: CompletionEvent[] = [];
  const pageSize = 500;
  for (let page = 1; page <= 400; page++) {
    const params = new URLSearchParams({ startDate: start, endDate: end, page: String(page), pageSize: String(pageSize) });
    const rows = await pfGet<CompletionEvent[]>(`/OrderProducts/CompletedProduction?${params}`, { fresh: true });
    for (const row of rows) if (row.status === 'frameCompleted') events.push(row);
    if (rows.length < pageSize) break;
  }
  return events;
}

/** Every designer with at least one frame first reaching No Response in the week. */
export async function loadDesignerWeeks(weekOf: string): Promise<DesignerWeek[]> {
  const weekEnd = isoAddDays(weekOf, 6);
  // Fetch one extra day each side so the Denver-calendar filter below sees
  // every event regardless of how the API buckets its date range.
  const events = await fetchFrameCompletedEvents(isoAddDays(weekOf, -LOOKBACK_DAYS), isoAddDays(weekEnd, 1));

  const firstByProduct = new Map<string, CompletionEvent>();
  for (const e of events) {
    const prev = firstByProduct.get(e.orderProductUuid);
    if (!prev || e.effectiveAt < prev.effectiveAt) firstByProduct.set(e.orderProductUuid, e);
  }

  const framesByDesigner = new Map<string, { name: string; frames: QualifyingFrame[] }>();
  for (const e of firstByProduct.values()) {
    const day = denverDate(e.effectiveAt);
    if (day < weekOf || day > weekEnd) continue;
    const raw = e.staffName?.trim();
    if (!raw || isNonProductionStaff(raw)) continue;
    const name = staffDisplayName(raw);
    if (isNonProductionStaff(name)) continue;
    const key = normalizeAssignmentStaffName(name);
    const entry = framesByDesigner.get(key) ?? { name, frames: [] };
    entry.frames.push({
      orderNum: String(e.orderNumber),
      orderProductUuid: e.orderProductUuid,
      variantTitle: e.variantTitle ?? null,
      firstNoResponseAt: e.effectiveAt,
    });
    framesByDesigner.set(key, entry);
  }

  const [hoursRes, staffRes] = await Promise.all([
    supabase
      .from('team_member_week_actuals')
      .select('member_name, location, department, actual_hours')
      .eq('week_of', weekOf),
    supabase.from('staff_locations').select('name, location'),
  ]);
  if (hoursRes.error) throw hoursRes.error;
  if (staffRes.error) throw staffRes.error;

  const hoursByKey = new Map<string, { name: string; hours: number; location: string | null; designLocation: string | null }>();
  for (const r of hoursRes.data ?? []) {
    const key = normalizeAssignmentStaffName(r.member_name);
    const entry = hoursByKey.get(key) ?? { name: r.member_name, hours: 0, location: null, designLocation: null };
    entry.hours += Number(r.actual_hours ?? 0);
    entry.location ??= r.location;
    if (r.department === 'design') entry.designLocation = r.location;
    hoursByKey.set(key, entry);
  }
  const staffLocation = new Map<string, string>();
  for (const r of staffRes.data ?? []) {
    if (r.name && r.location) staffLocation.set(normalizeAssignmentStaffName(r.name), r.location);
  }

  return [...framesByDesigner.entries()]
    .map(([key, { name, frames }]) => {
      const h = hoursByKey.get(key);
      return {
        // Prefer the payroll spelling so grades line up with Historicals/Scorecards.
        designerName: h?.name ?? name,
        location: h?.designLocation ?? h?.location ?? staffLocation.get(key) ?? null,
        // 0 hours means none were uploaded for them (e.g. salaried) — treat as unknown.
        hours: h && h.hours > 0 ? Math.round(h.hours * 100) / 100 : null,
        frames: frames.sort((a, b) => a.firstNoResponseAt.localeCompare(b.firstNoResponseAt)),
      };
    })
    .sort((a, b) => (a.location ?? '~').localeCompare(b.location ?? '~') || a.designerName.localeCompare(b.designerName));
}

/** Picks `count` distinct items uniformly at random (crypto RNG). */
export function pickRandom<T>(items: T[], count: number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
}

/** Monday (YYYY-MM-DD) of the most recently finished Mon–Sun week, Denver time. */
export function lastCompletedWeekOf(now = new Date()): string {
  const today = now.toLocaleDateString('en-CA', { timeZone: TZ });
  const d = new Date(today + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0 = Sun
  const thisMonday = isoAddDays(today, dow === 0 ? -6 : 1 - dow);
  return isoAddDays(thisMonday, -7);
}

export function isMondayIso(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T12:00:00Z').getUTCDay() === 1;
}
