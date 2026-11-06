export interface ResinCohort {
  weekOf: string; // ISO Monday
  units: number;
}

export interface ProjectedResinCohort extends ResinCohort {
  estimated: boolean;
}

// Fills out the resin queue's intake weeks to the planning horizon.
//
// Real cohorts only cover orders customers have already placed, and future
// weeks fill in as event dates get booked — so a future week is sparse rather
// than complete, and one order for a wedding a year out says nothing about the
// weeks before it. Every future week in the horizon therefore gets at least
// the recent average intake, flagged `estimated`; a week whose real bookings
// already beat the average keeps its real count.
//
// The average uses completed weeks only: the current week is still filling up,
// and future weeks are just the sparse bookings described above.
//
// horizonWeeks: ISO Mondays in order, starting with the current week.
// recentFromWeek: first ISO Monday counted toward the average.
export function projectResinCohorts(
  cohorts: ResinCohort[],
  horizonWeeks: string[],
  recentFromWeek: string,
): ProjectedResinCohort[] {
  const currentWeek = horizonWeeks[0];
  const recent = cohorts.filter(c => c.weekOf >= recentFromWeek && c.weekOf < currentWeek);
  const avgIntake = recent.length > 0
    ? Math.round(recent.reduce((sum, c) => sum + c.units, 0) / recent.length)
    : 0;

  const byWeek = new Map<string, ProjectedResinCohort>(
    cohorts.map(c => [c.weekOf, { ...c, estimated: false }]),
  );
  if (avgIntake > 0) {
    for (const weekOf of horizonWeeks.slice(1)) {
      const real = byWeek.get(weekOf);
      if (!real || real.units < avgIntake) {
        byWeek.set(weekOf, { weekOf, units: avgIntake, estimated: true });
      }
    }
  }
  return [...byWeek.values()].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
}
