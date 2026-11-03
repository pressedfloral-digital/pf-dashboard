// Day-by-day Preservation flow, the same math as the Preservation Team Hours
// Calculator spreadsheet: bouquets arrive on a fixed weekday mix, the team
// presses oldest first up to each day's capacity (hours ÷ ratio), and
// whatever's left rolls into the next day — and past Friday, into next week.
//
// Read-only: nothing here feeds the staffing check, queue or historicals.

// Share of a week's bouquets arriving each weekday (Mon–Fri), in percent.
export const DEFAULT_FLOW_DAY_PCTS = [5, 50, 25, 15, 5];

export type TurnaroundStatus = 'onTarget' | 'day2' | 'past2';

export const TURNAROUND_LABEL: Record<TurnaroundStatus, string> = {
  onTarget: 'On target',
  day2:     'Using day 2',
  past2:    'Past 2 days',
};

export interface FlowDayInput {
  iso:      string;
  hours:    number;          // scheduled production hours
  capacity: number;          // bouquets those hours can press (hours ÷ ratio)
  arrivals: number;          // bouquets coming in
  pressed?: number;          // actual bouquets pressed — set for days already past
}

export interface FlowDay extends FlowDayInput {
  leftIn:      number;       // waiting from the day before
  start:       number;       // arrivals + leftIn
  done:        number;       // pressed: actual when known, else min(start, capacity)
  remaining:   number;       // still waiting at end of day
  hoursUsed:   number;
  hoursIdle:   number;       // scheduled but not needed
  hoursShort:  number;       // extra hours to clear what's still waiting
  status:      TurnaroundStatus;
  actual:      boolean;
}

export interface FlowWeek {
  days:           FlowDay[];
  carryIn:        number;
  arrivals:       number;
  scheduledHours: number;
  capacity:       number;
  hoursNeeded:    number;    // hours to press this week's arrivals plus the carry-in
  overShort:      number;    // scheduled − needed (negative = short)
  hoursIdle:      number;
  capacityUsed:   number | null; // share of capacity actually needed, 0–1+
  carryOut:       number;    // still waiting at end of the week
  daysPast2:      number;
}

// prevArrivals: what arrived the day before Monday (last week's Friday), for
// the "Past 2 days" test on Monday. Defaults to the carry-in, like the sheet.
export function simulateFlowWeek(input: FlowDayInput[], carryIn: number, prevArrivals = carryIn): FlowWeek {
  const scheduledHours = input.reduce((s, d) => s + d.hours, 0);
  const capacity = input.reduce((s, d) => s + d.capacity, 0);
  // Hours per bouquet across the week — used when a single day has no
  // capacity to measure itself against.
  const weekHrsPerBq = capacity > 0 ? scheduledHours / capacity : 0;

  let leftIn = carryIn;
  let yesterdayIn = prevArrivals;
  const days = input.map(d => {
    const start = d.arrivals + leftIn;
    const actual = d.pressed !== undefined;
    const done = actual ? Math.min(start, d.pressed!) : Math.min(start, d.capacity);
    const remaining = Math.max(0, start - done);
    const hrsPerBq = d.capacity > 0 ? d.hours / d.capacity : weekHrsPerBq;
    const hoursUsed = Math.min(d.hours, done * hrsPerBq);
    const status: TurnaroundStatus =
      remaining - d.arrivals - yesterdayIn > 0.001 ? 'past2'
        : remaining - d.arrivals > 0.001 ? 'day2'
        : 'onTarget';
    const day: FlowDay = {
      ...d, leftIn, start, done, remaining, hoursUsed,
      hoursIdle: Math.max(0, d.hours - hoursUsed),
      hoursShort: remaining * hrsPerBq,
      status, actual,
    };
    leftIn = remaining;
    yesterdayIn = d.arrivals;
    return day;
  });

  const arrivals = input.reduce((s, d) => s + d.arrivals, 0);
  const carryOut = days.length ? days[days.length - 1].remaining : carryIn;
  return {
    days, carryIn, arrivals, scheduledHours, capacity,
    hoursNeeded: (arrivals + carryIn) * weekHrsPerBq,
    overShort: scheduledHours - (arrivals + carryIn) * weekHrsPerBq,
    hoursIdle: days.reduce((s, d) => s + d.hoursIdle, 0),
    capacityUsed: capacity > 0 ? (arrivals + carryIn - carryOut) / capacity : null,
    carryOut,
    daysPast2: days.filter(d => d.status === 'past2').length,
  };
}

// A week's estimate split across Mon–Fri by the mix (normalized, so a mix
// that doesn't add to 100 still spreads the whole estimate).
export function splitArrivals(weekEstimate: number, pcts: number[]): number[] {
  const total = pcts.reduce((s, p) => s + Math.max(0, p), 0);
  return pcts.map(p => total > 0 ? weekEstimate * Math.max(0, p) / total : weekEstimate / pcts.length);
}
