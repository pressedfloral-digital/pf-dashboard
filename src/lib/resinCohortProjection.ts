export interface ResinCohort {
  weekOf: string; // ISO Monday
  units: number;
}

export interface ProjectedResinCohort extends ResinCohort {
  estimated: boolean;
}

// Orders physically arrive for resin work a few days after the customer's
// event (wedding), not at Shopify checkout time — checkout can happen weeks
// before or after the event. Midpoint of the 3–6 day range the resin team
// gave us.
export const EVENT_TO_INTAKE_OFFSET_DAYS = 4;

// The week the flowers actually arrived for resin work, not the week the order
// was placed on Shopify. When the order carries an event-date tag, intake =
// event date + offset; otherwise fall back to order_date (photo-inspiration
// orders and anything synced before this field existed have no event-date tag).
export function resinIntakeWeek(r: { event_date: string | null; order_date: string | null }): string | null {
  let intake = r.order_date;
  if (r.event_date) {
    const shifted = new Date(r.event_date + 'T12:00:00');
    shifted.setDate(shifted.getDate() + EVENT_TO_INTAKE_OFFSET_DAYS);
    intake = shifted.toISOString().split('T')[0];
  }
  if (!intake) return null;
  const d = new Date(intake + 'T12:00:00');
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().split('T')[0];
}

// Resin units as a fraction of bouquets received, totalled over the given
// weeks so a single lumpy week can't swing it. Weeks with no bouquet count are
// skipped rather than read as zero. Null when there's nothing to compare.
export function resinShareOfBouquets(
  resinByWeek: Record<string, number>,
  bouquetsByWeek: Record<string, number>,
  weeks: string[],
): number | null {
  let resin = 0;
  let bouquets = 0;
  for (const week of weeks) {
    const received = bouquetsByWeek[week];
    if (!received) continue;
    bouquets += received;
    resin += resinByWeek[week] ?? 0;
  }
  return bouquets > 0 && resin > 0 ? resin / bouquets : null;
}

// Fills out the resin queue's intake weeks to the planning horizon.
//
// Real cohorts only cover orders customers have already placed, and future
// weeks fill in as event dates get booked — so a future week is sparse rather
// than complete, and one order for a wedding a year out says nothing about the
// weeks before it. Every future week with an estimate therefore gets at least
// that estimate, flagged `estimated`; a week whose real bookings already beat
// it keeps its real count, as does the current week.
//
// horizonWeeks: ISO Mondays in order, starting with the current week.
export function projectResinCohorts(
  cohorts: ResinCohort[],
  horizonWeeks: string[],
  estimateByWeek: Record<string, number>,
): ProjectedResinCohort[] {
  const byWeek = new Map<string, ProjectedResinCohort>(
    cohorts.map(c => [c.weekOf, { ...c, estimated: false }]),
  );
  for (const weekOf of horizonWeeks.slice(1)) {
    const estimate = estimateByWeek[weekOf];
    if (!estimate) continue;
    const real = byWeek.get(weekOf);
    if (!real || real.units < estimate) {
      byWeek.set(weekOf, { weekOf, units: estimate, estimated: true });
    }
  }
  return [...byWeek.values()].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
}
