'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { getMondayDate, getWeekLabel } from '@/lib/weekDates';

// ─── Types ─────────────────────────────────────────────────────────────────────

type PayType = 'hourly' | 'salary';

interface Designer {
  id:           string;
  name:         string;
  ratio:        number;
  payType:      PayType;
  hourlyRate:   number;
  annualSalary: number;
}

interface WeekSchedule {
  [designerId: string]: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const WEEKS  = 52;
const WINDOW = 8;
const PRESERVATION_WEEKS = 6; // min weeks before anything can be designed

// ─── Historical Utah intake (actual received by week) ─────────────────────────
// Keyed by ISO week start date (Monday). Values = actual order products received.
// Week 40 2025 = Sep 29 2025. Current week = week 14 2026 = Apr 6 2026.
// These feed the "weeks remaining until design" calculation.
const UTAH_HISTORICAL_INTAKE: { weekOf: string; actual: number }[] = [
  { weekOf: '2025-09-29', actual: 187 }, // wk 40
  { weekOf: '2025-10-06', actual: 167 }, // wk 41
  { weekOf: '2025-10-13', actual: 192 }, // wk 42
  { weekOf: '2025-10-20', actual: 159 }, // wk 43
  { weekOf: '2025-10-27', actual: 139 }, // wk 44
  { weekOf: '2025-11-03', actual: 97  }, // wk 45
  { weekOf: '2025-11-10', actual: 110 }, // wk 46
  { weekOf: '2025-11-17', actual: 68  }, // wk 47
  { weekOf: '2025-11-24', actual: 39  }, // wk 48
  { weekOf: '2025-12-01', actual: 15  }, // wk 49
  { weekOf: '2025-12-08', actual: 29  }, // wk 50
  { weekOf: '2025-12-15', actual: 41  }, // wk 51
  { weekOf: '2025-12-22', actual: 16  }, // wk 52
  { weekOf: '2025-12-29', actual: 24  }, // wk 1 2026
  { weekOf: '2026-01-05', actual: 22  }, // wk 2
  { weekOf: '2026-01-12', actual: 18  }, // wk 3
  { weekOf: '2026-01-19', actual: 22  }, // wk 4
  { weekOf: '2026-01-26', actual: 12  }, // wk 5
  { weekOf: '2026-02-02', actual: 10  }, // wk 6
  { weekOf: '2026-02-09', actual: 25  }, // wk 7
  { weekOf: '2026-02-16', actual: 27  }, // wk 8
  { weekOf: '2026-02-23', actual: 24  }, // wk 9
  { weekOf: '2026-03-02', actual: 13  }, // wk 10
  { weekOf: '2026-03-09', actual: 28  }, // wk 11
  { weekOf: '2026-03-16', actual: 47  }, // wk 12
  { weekOf: '2026-03-23', actual: 43  }, // wk 13
  { weekOf: '2026-03-30', actual: 31  }, // wk 14 (current, projected)
];

// ─── Default designers ────────────────────────────────────────────────────────

const DEFAULT_UTAH_DESIGNERS: Designer[] = [
  { id: 'ut-mgr', name: 'Jennika Merrill',  ratio: 1.4, payType: 'salary', hourlyRate: 0, annualSalary: 0 },
  { id: 'ut-1',   name: 'Deanna L Brown',   ratio: 1.6, payType: 'hourly', hourlyRate: 0, annualSalary: 0 },
  { id: 'ut-2',   name: 'Sarah Glissmeyer', ratio: 1.8, payType: 'hourly', hourlyRate: 0, annualSalary: 0 },
  { id: 'ut-3',   name: 'Kathryn Hill',     ratio: 1.4, payType: 'hourly', hourlyRate: 0, annualSalary: 0 },
  { id: 'ut-4',   name: 'Mia Legas',        ratio: 1.2, payType: 'hourly', hourlyRate: 0, annualSalary: 0 },
  { id: 'ut-5',   name: 'Sloane James',     ratio: 1.2, payType: 'hourly', hourlyRate: 0, annualSalary: 0 },
  { id: 'ut-6',   name: 'Audrey Brown',     ratio: 2.0, payType: 'hourly', hourlyRate: 0, annualSalary: 0 },
  { id: 'ut-7',   name: 'Chloe Leonard',    ratio: 1.6, payType: 'hourly', hourlyRate: 0, annualSalary: 0 },
];

const DEFAULT_GEORGIA_DESIGNERS: Designer[] = [
  { id: 'ga-mgr', name: 'Manager',    ratio: 1.4, payType: 'salary', hourlyRate: 0, annualSalary: 0 },
  { id: 'ga-1',   name: 'Designer A', ratio: 1.5, payType: 'hourly', hourlyRate: 0, annualSalary: 0 },
  { id: 'ga-2',   name: 'Designer B', ratio: 1.5, payType: 'hourly', hourlyRate: 0, annualSalary: 0 },
];

function buildDefaultUtahSchedule(): WeekSchedule[] {
  return Array.from({ length: WEEKS }, (_, w) => ({
    'ut-mgr': 15,
    'ut-1':   28,
    'ut-2':   15,
    'ut-3':   20,
    'ut-4':   16,
    'ut-5':   w <= 12 ? 20 : 0,
    'ut-6':   w <= 4  ? 10 : 0,
    'ut-7':   0,
  }));
}

function buildDefaultGeorgiaSchedule(): WeekSchedule[] {
  return Array.from({ length: WEEKS }, () => ({
    'ga-mgr': 0, 'ga-1': 0, 'ga-2': 0,
  }));
}

// ─── Helpers ───────────────────────────────────────────────────────────────────


function getMonthKey(offsetWeeks: number): string {
  return getMondayDate(offsetWeeks).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function fmt$(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function initSchedule(designers: Designer[]): WeekSchedule[] {
  return Array.from({ length: WEEKS }, () =>
    Object.fromEntries(designers.map(d => [d.id, 0]))
  );
}

// ─── Turnaround color helpers ─────────────────────────────────────────────────

function turnaroundColors(totalWeeks: number | null, overstaffed: boolean) {
  if (totalWeeks === null) return { bar: 'bg-red-400', text: 'text-red-700', label: 'queue not cleared in 52 wks' };
  if (overstaffed)         return { bar: 'bg-orange-400', text: 'text-orange-700', label: `~${totalWeeks} wks — overstaffed` };
  if (totalWeeks <= 10)    return { bar: 'bg-green-400',  text: 'text-green-700',  label: `~${totalWeeks} wks — ideal` };
  if (totalWeeks <= 18)    return { bar: 'bg-amber-400',  text: 'text-amber-700',  label: `~${totalWeeks} wks — backlog building` };
  return                          { bar: 'bg-red-600',   text: 'text-red-800',    label: `~${totalWeeks} wks — large backlog` };
}

// ─── RosterEditor ──────────────────────────────────────────────────────────────

function RosterEditor({ designers, onChange, onAdd, onRemove }: {
  designers: Designer[];
  onChange:  (id: string, field: keyof Designer, value: string) => void;
  onAdd:     () => void;
  onRemove:  (id: string) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-[1fr_80px_80px_110px_130px_20px] gap-2 mb-2 px-1 text-xs font-medium text-slate-400">
        <span>Name</span><span className="text-center">Pay type</span>
        <span className="text-center">Ratio</span><span className="text-center">Hourly rate</span>
        <span className="text-center">Annual salary</span><span />
      </div>
      <div className="space-y-2">
        {designers.map(d => (
          <div key={d.id} className="grid grid-cols-[1fr_80px_80px_110px_130px_20px] gap-2 items-center">
            <input type="text" value={d.name} onChange={e => onChange(d.id, 'name', e.target.value)}
              className="border border-slate-200 rounded px-2 py-1.5 text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
            <select value={d.payType} onChange={e => onChange(d.id, 'payType', e.target.value)}
              className="border border-slate-200 rounded px-1.5 py-1.5 text-xs text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300">
              <option value="hourly">Hourly</option>
              <option value="salary">Salary</option>
            </select>
            <input type="number" value={d.ratio} step="0.1" min="0.1" onChange={e => onChange(d.id, 'ratio', e.target.value)}
              className="border border-slate-200 rounded px-2 py-1.5 text-sm text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none">$</span>
              <input type="number" value={d.hourlyRate || ''} step="0.50" min="0" placeholder="0"
                disabled={d.payType === 'salary'} onChange={e => onChange(d.id, 'hourlyRate', e.target.value)}
                className="w-full pl-5 border border-slate-200 rounded px-2 py-1.5 text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 disabled:opacity-30 disabled:bg-slate-50" />
            </div>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none">$</span>
              <input type="number" value={d.annualSalary || ''} step="1000" min="0" placeholder="e.g. 52000"
                disabled={d.payType === 'hourly'} onChange={e => onChange(d.id, 'annualSalary', e.target.value)}
                className="w-full pl-5 border border-slate-200 rounded px-2 py-1.5 text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 disabled:opacity-30 disabled:bg-slate-50" />
            </div>
            <button onClick={() => onRemove(d.id)} className="text-slate-300 hover:text-red-400 transition-colors text-xl leading-none text-center">×</button>
          </div>
        ))}
      </div>
      <button onClick={onAdd} className="mt-3 text-xs px-3 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 transition-colors">
        + Add designer
      </button>
      <p className="mt-3 text-xs text-slate-400">
        <strong>Salary:</strong> enter annual — divided by 52 for weekly CPO.&nbsp;
        <strong>Hourly:</strong> cost = hours × rate.
      </p>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function SchedulePage() {
  const [location, setLocation] = useState<'Utah' | 'Georgia'>('Utah');

  const [utahDesigners,    setUtahDesigners]    = useState<Designer[]>(DEFAULT_UTAH_DESIGNERS);
  const [georgiaDesigners, setGeorgiaDesigners] = useState<Designer[]>(DEFAULT_GEORGIA_DESIGNERS);
  const [utahSchedule,     setUtahSchedule]     = useState<WeekSchedule[]>(buildDefaultUtahSchedule);
  const [georgiaSchedule,  setGeorgiaSchedule]  = useState<WeekSchedule[]>(buildDefaultGeorgiaSchedule);

  const [designableQueue,   setDesignableQueue]   = useState(0);
  const [preservationQueue, setPreservationQueue] = useState(0);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [avgIntake,    setAvgIntake]    = useState(45); // Utah recent average

  const [showRoster,  setShowRoster]  = useState(false);
  const [weekOffset,  setWeekOffset]  = useState(0);
  const [showCPO,     setShowCPO]     = useState(true);
  const [activeTab,   setActiveTab]   = useState<'schedule' | 'monthly' | 'queue'>('schedule');

  const [deletedStack, setDeletedStack] = useState<{designer: Designer; schedule: WeekSchedule[]}[]>([]);

  const designers    = location === 'Utah' ? utahDesigners    : georgiaDesigners;
  const schedule     = location === 'Utah' ? utahSchedule     : georgiaSchedule;
  const setDesigners = location === 'Utah' ? setUtahDesigners : setGeorgiaDesigners;
  const setSchedule  = location === 'Utah' ? setUtahSchedule  : setGeorgiaSchedule;

  // ── Fetch pipeline ────────────────────────────────────────────────────────────
  const fetchQueue = useCallback(async () => {
    setLoadingQueue(true);
    try {
      const [rtfRes, artfRes, brRes, coRes, prRes] = await Promise.all([
        fetch(`/api/pipeline-orders?status=readyToFrame&location=${location}`),
        fetch(`/api/pipeline-orders?status=almostReadyToFrame&location=${location}`),
        fetch(`/api/pipeline-orders?status=bouquetReceived&location=${location}`),
        fetch(`/api/pipeline-orders?status=checkedOn&location=${location}`),
        fetch(`/api/pipeline-orders?status=progress&location=${location}`),
      ]);
      const [rtf, artf, br, co, pr] = await Promise.all([
        rtfRes.json(), artfRes.json(), brRes.json(), coRes.json(), prRes.json(),
      ]);
      setDesignableQueue((rtf.orders?.length ?? 0) + (artf.orders?.length ?? 0));
      setPreservationQueue((br.orders?.length ?? 0) + (co.orders?.length ?? 0) + (pr.orders?.length ?? 0));
    } catch { /* leave as-is */ }
    finally { setLoadingQueue(false); }
  }, [location]);

  useEffect(() => { void fetchQueue(); }, [fetchQueue]);

  // ── Roster handlers ──────────────────────────────────────────────────────────
  function handleDesignerChange(id: string, field: keyof Designer, value: string) {
    setDesigners(prev => prev.map(d => {
      if (d.id !== id) return d;
      if (field === 'name')    return { ...d, name: value };
      if (field === 'payType') return { ...d, payType: value as PayType };
      return { ...d, [field]: parseFloat(value) || 0 };
    }));
  }
  function handleAddDesigner() {
    const id = `${location.toLowerCase()}-${Date.now()}`;
    const d: Designer = { id, name: 'New Designer', ratio: 1.5, payType: 'hourly', hourlyRate: 0, annualSalary: 0 };
    setDesigners(prev => [...prev, d]);
    setSchedule(prev => prev.map(week => ({ ...week, [id]: 0 })));
  }
  function handleRemoveDesigner(id: string) {
    const designer = designers.find(d => d.id === id);
    if (designer) setDeletedStack(prev => [...prev, { designer, schedule: schedule.map(w => ({ ...w })) }]);
    setDesigners(prev => prev.filter(d => d.id !== id));
    setSchedule(prev => prev.map(week => { const n = { ...week }; delete n[id]; return n; }));
  }
  function handleUndo() {
    const last = deletedStack[deletedStack.length - 1];
    if (!last) return;
    setDesigners(prev => [...prev, last.designer]);
    setSchedule(last.schedule);
    setDeletedStack(prev => prev.slice(0, -1));
  }

  // ── Schedule handlers ────────────────────────────────────────────────────────
  function handleHoursChange(weekIdx: number, designerId: string, value: string) {
    setSchedule(prev => {
      const next = [...prev];
      next[weekIdx] = { ...next[weekIdx], [designerId]: parseFloat(value) || 0 };
      return next;
    });
  }
  function applyToAllWeeks(designerId: string, hours: number) {
    setSchedule(prev => prev.map(week => ({ ...week, [designerId]: hours })));
  }

  // ── Per-designer stats ────────────────────────────────────────────────────────
  function weekStats(weekIdx: number, d: Designer) {
    const hrs    = schedule[weekIdx]?.[d.id] ?? 0;
    const frames = d.ratio > 0 ? hrs / d.ratio : 0;
    const cost   = d.payType === 'salary' ? d.annualSalary / 52 : hrs * d.hourlyRate;
    const cpo    = frames > 0 && cost > 0 ? cost / frames : null;
    return { hrs, frames, cost, cpo };
  }

  // ── Weekly totals ─────────────────────────────────────────────────────────────
  const weeklyTotals = useMemo(() =>
    Array.from({ length: WEEKS }, (_, w) => {
      let totalFrames = 0, totalCost = 0;
      designers.forEach(d => {
        const { frames, cost } = weekStats(w, d);
        totalFrames += frames;
        totalCost   += cost;
      });
      return { totalFrames, totalCost, totalCPO: totalFrames > 0 && totalCost > 0 ? totalCost / totalFrames : null };
    }),
    [schedule, designers] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Monthly aggregation ───────────────────────────────────────────────────────
  const monthlyData = useMemo(() => {
    const map: Record<string, { monthKey: string; weeks: number; totalFrames: number; totalCost: number; totalHours: number; byDesigner: Record<string, { frames: number; cost: number; hrs: number }> }> = {};
    for (let w = 0; w < WEEKS; w++) {
      const key = getMonthKey(w);
      if (!map[key]) map[key] = { monthKey: key, weeks: 0, totalFrames: 0, totalCost: 0, totalHours: 0, byDesigner: {} };
      map[key].weeks++;
      map[key].totalFrames += weeklyTotals[w].totalFrames;
      map[key].totalCost   += weeklyTotals[w].totalCost;
      designers.forEach(d => {
        const { frames, cost, hrs } = weekStats(w, d);
        if (!map[key].byDesigner[d.id]) map[key].byDesigner[d.id] = { frames: 0, cost: 0, hrs: 0 };
        map[key].byDesigner[d.id].frames += frames;
        map[key].byDesigner[d.id].cost   += cost;
        map[key].byDesigner[d.id].hrs    += hrs;
        map[key].totalHours += hrs;
      });
    }
    return Object.values(map).map(m => ({
      ...m,
      monthlyRatio: m.totalFrames > 0 ? m.totalHours / m.totalFrames : null,
      monthlyCPO:   m.totalFrames > 0 && m.totalCost > 0 ? m.totalCost / m.totalFrames : null,
    }));
  }, [weeklyTotals, designers, schedule]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Future turnaround (for orders arriving in future weeks) ───────────────────
  const futureTurnarounds = useMemo(() => {
    // Correct model:
    // Orders received week W graduate into the DESIGN queue at week W+6.
    // The graduation rate each week = what was received exactly 6 weeks prior.
    // For past weeks: use actual historical intake data.
    // For future weeks: use avgIntake as the projection.
    //
    // We simulate the design queue week by week:
    //   queue[w+1] = max(0, queue[w] - capacity[w]) + graduating[w]
    // where graduating[w] = intake received 6 weeks before week w.
    //
    // For week W's turnaround: orders arrive week W, graduate at week W+6.
    // Their wait = how many weeks from W+6 until the queue clears past them.

    // Build a map of "graduating into design queue" for each future week index
    // Index 0 = current week. Graduating[w] = orders received 6 weeks ago relative to week w.
    const graduating: number[] = Array.from({ length: WEEKS }, (_, w) => {
      // Week w corresponds to calendar offset w from current Monday.
      // 6 weeks prior = offset w-6, which maps to a specific ISO date.
      const graduatingDate = getMondayDate(w - PRESERVATION_WEEKS);
      const graduatingIso  = graduatingDate.toISOString().split('T')[0];
      // Check if we have actual data for that week
      const actual = UTAH_HISTORICAL_INTAKE.find(h => h.weekOf === graduatingIso);
      return actual ? actual.actual : avgIntake;
    });

    // Simulate design queue week by week
    const queueAtStart: number[] = [designableQueue];
    for (let w = 0; w < WEEKS - 1; w++) {
      const afterDrain    = Math.max(0, queueAtStart[w] - weeklyTotals[w].totalFrames);
      const afterGraduate = afterDrain + graduating[w + 1]; // next week's graduating cohort
      queueAtStart.push(afterGraduate);
    }

    // For each week W: orders received that week graduate at W+6.
    // At W+6, they join behind queueAtStart[W+6] (queue before capacity that week).
    // Find when the queue drains past them.
    return Array.from({ length: WEEKS }, (_, w) => {
      const graduateWeek = w + PRESERVATION_WEEKS;
      if (graduateWeek >= WEEKS) return null;

      const queueAhead  = queueAtStart[graduateWeek]; // orders ahead of this cohort
      const cohortSize  = graduating[w]; // size of this cohort (= what was received week W)
      let remaining     = queueAhead + cohortSize;

      for (let fw = graduateWeek; fw < WEEKS; fw++) {
        remaining -= weeklyTotals[fw].totalFrames;
        if (remaining <= 0) return fw - w; // total weeks = preservation + design wait
      }
      return null;
    });
  }, [designableQueue, avgIntake, weeklyTotals]);

  // ── Historical "weeks remaining" calculation ──────────────────────────────────
  // Precise FIFO positioning based on actual pipeline analysis:
  //
  // We know from the pipeline that designers are currently working through
  // the week 42 (Oct 13 2025) cohort. The RTF queue of 879 + ARTF 45 = 924
  // total designable. Summing actual intake from wk 6 back to wk 43 = ~821,
  // meaning wk 42's 192-order cohort is partially done (~58 remaining).
  //
  // So the FIFO queue is built as:
  //   [~58 remaining from wk42] + [all of wk43] + [wk44] + ... + [wk6]
  // Then we drain it week by week using scheduled capacity.
  // In-preservation cohorts (wks 7-14) are shown separately.
  const historicalRemaining = useMemo(() => {
    const historicalIntake = location === 'Utah' ? UTAH_HISTORICAL_INTAKE : [];
    if (!historicalIntake.length) return [];

    const today = getMondayDate(0);

    // Split cohorts: designable (age >= 6 wks) vs still in preservation
    const designableCohorts: { weekOf: string; count: number }[] = [];
    const inPreservationCohorts: { weekOf: string; count: number; weeksLeft: number }[] = [];

    historicalIntake.forEach(({ weekOf, actual }) => {
      const intakeDate = new Date(weekOf + 'T12:00:00');
      const ageWeeks   = Math.floor((today.getTime() - intakeDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
      if (ageWeeks >= PRESERVATION_WEEKS) {
        designableCohorts.push({ weekOf, count: actual });
      } else {
        inPreservationCohorts.push({ weekOf, count: actual, weeksLeft: PRESERVATION_WEEKS - ageWeeks });
      }
    });

    // Build the precise FIFO queue.
    // The oldest cohort (wk 42, Oct 13 2025) is partially consumed.
    // We calculate how many remain by: sum all designable cohorts = X,
    // then the oldest cohort has (X - designableQueue) already designed,
    // leaving (oldest.count - (X - designableQueue)) remaining.
    const totalFromHistory = designableCohorts.reduce((s, c) => s + c.count, 0);
    const alreadyDesigned  = Math.max(0, totalFromHistory - designableQueue);

    // Build queue with oldest first, trimming the already-designed portion from front
    let trimRemaining = alreadyDesigned;
    const queueCohorts: { weekOf: string; remaining: number }[] = [];
    for (const c of designableCohorts) {
      if (trimRemaining >= c.count) {
        // Entire cohort already designed — mark as 0 remaining
        queueCohorts.push({ weekOf: c.weekOf, remaining: 0 });
        trimRemaining -= c.count;
      } else {
        // Partially consumed
        queueCohorts.push({ weekOf: c.weekOf, remaining: c.count - trimRemaining });
        trimRemaining = 0;
      }
    }

    // Simulate FIFO drain using weekly capacity
    const results: { weekOf: string; weeksFromNow: number | null; alreadyDone: boolean }[] =
      queueCohorts.map(c => ({ weekOf: c.weekOf, weeksFromNow: null, alreadyDone: c.remaining === 0 }));

    let cohortIdx = queueCohorts.findIndex(c => c.remaining > 0); // start at first unfinished
    if (cohortIdx === -1) cohortIdx = queueCohorts.length;

    let remainingInCohort = queueCohorts[cohortIdx]?.remaining ?? 0;

    for (let w = 0; w < WEEKS && cohortIdx < queueCohorts.length; w++) {
      let capacity = weeklyTotals[w].totalFrames;
      while (capacity > 0 && cohortIdx < queueCohorts.length) {
        if (remainingInCohort <= capacity) {
          results[cohortIdx].weeksFromNow = w;
          capacity -= remainingInCohort;
          cohortIdx++;
          remainingInCohort = queueCohorts[cohortIdx]?.remaining ?? 0;
        } else {
          remainingInCohort -= capacity;
          capacity = 0;
        }
      }
    }

    // Simulate in-preservation cohorts joining the queue after the current queue drains.
    // After the FIFO drain above, we know the queue state at each future week.
    // Each in-preservation cohort joins at week = preservationWeeksLeft from now.
    // We continue the drain simulation from where the designable cohorts left off.

    // First, compute queue remaining after each future week (from the drain above)
    const queueAfterWeek: number[] = [];
    {
      let q = designableQueue;
      for (let w = 0; w < WEEKS; w++) {
        const cap = weeklyTotals[w].totalFrames;
        q = Math.max(0, q - cap);
        queueAfterWeek.push(q);
      }
    }

    // For each in-preservation cohort, find when it gets designed:
    // It joins the queue at week = preservationWeeksLeft.
    // At that point the queue size = queueAfterWeek[preservationWeeksLeft - 1] (or designableQueue if week 0).
    // Then drain that cohort through remaining capacity in subsequent weeks.
    const presResults = inPreservationCohorts.map(c => {
      const joinWeek = c.weeksLeft; // week index when cohort enters design queue
      // Queue size at the moment this cohort joins
      const queueAtJoin = joinWeek === 0 ? designableQueue : (queueAfterWeek[joinWeek - 1] ?? 0);
      // This cohort sits behind queueAtJoin orders. Find when those + this cohort drain.
      let remaining = queueAtJoin + c.count;
      let designedAtWeek: number | null = null;
      for (let fw = joinWeek; fw < WEEKS; fw++) {
        remaining -= weeklyTotals[fw].totalFrames;
        if (remaining <= 0) { designedAtWeek = fw; break; }
      }
      return {
        weekOf:                c.weekOf,
        weeksFromNow:          designedAtWeek,
        alreadyDone:           false,
        inPreservation:        true,
        preservationWeeksLeft: c.weeksLeft,
      };
    });

    // Combine and sort oldest first
    const allResults = [
      ...results,
      ...presResults,
    ].sort((a, b) => a.weekOf.localeCompare(b.weekOf));

    return allResults;
  }, [location, designableQueue, weeklyTotals]);

  const windowWeeks = Array.from({ length: WINDOW }, (_, i) => i + weekOffset).filter(i => i < WEEKS);
  const hasRates    = designers.some(d =>
    (d.payType === 'hourly' && d.hourlyRate > 0) ||
    (d.payType === 'salary' && d.annualSalary > 0)
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Design Schedule</h1>
            <p className="text-sm text-slate-400 mt-0.5">52-week capacity, turnaround &amp; cost projection</p>
          </div>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
            {(['Utah', 'Georgia'] as const).map(loc => (
              <button key={loc} onClick={() => setLocation(loc)}
                className={`px-5 py-2 transition-colors ${location === loc ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                {loc}
              </button>
            ))}
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-100 rounded-xl p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">Designable queue</p>
            <p className="text-xs text-slate-400 mb-2">Ready to Frame + Almost Ready</p>
            <div className="flex items-center gap-2">
              <input type="number" value={designableQueue} onChange={e => setDesignableQueue(parseInt(e.target.value) || 0)}
                className="w-20 border border-slate-200 rounded px-2 py-1 text-xl font-semibold text-indigo-700 focus:outline-none focus:ring-1 focus:ring-indigo-300" />
              <button onClick={() => void fetchQueue()} disabled={loadingQueue}
                className="text-xs px-2 py-1 border border-slate-200 rounded text-slate-400 hover:bg-slate-50 disabled:opacity-50">
                {loadingQueue ? '…' : '↻'}
              </button>
            </div>
          </div>
          <div className="bg-white border border-slate-100 rounded-xl p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">Preservation pipeline</p>
            <p className="text-xs text-slate-400 mb-2">Bouquet Received → In Progress</p>
            <p className="text-xl font-semibold text-green-700">{preservationQueue}</p>
          </div>
          <div className="bg-white border border-slate-100 rounded-xl p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">Weekly intake avg</p>
            <p className="text-xs text-slate-400 mb-2">new order products/week into design</p>
            <input type="number" value={avgIntake} onChange={e => setAvgIntake(parseInt(e.target.value) || 0)}
              className="w-20 border border-slate-200 rounded px-2 py-1 text-xl font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300" />
          </div>
          <div className="bg-white border border-slate-100 rounded-xl p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">This week capacity</p>
            <p className="text-xl font-semibold text-slate-900">
              {Math.round(weeklyTotals[0].totalFrames)}
              <span className="text-sm font-normal text-slate-400 ml-1">frames</span>
            </p>
            {hasRates && weeklyTotals[0].totalCPO !== null && (
              <p className="text-xs text-amber-600 mt-1 font-medium">CPO: {fmt$(weeklyTotals[0].totalCPO)}</p>
            )}
          </div>
        </div>

        {/* Roster */}
        <div>
          <button onClick={() => setShowRoster(r => !r)}
            className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
            {showRoster ? '▲ Hide' : '▼ Edit'} designer roster, ratios &amp; pay rates
          </button>
          {showRoster && (
            <div className="mt-3 bg-white border border-slate-100 rounded-xl p-5">
              <RosterEditor designers={designers} onChange={handleDesignerChange} onAdd={handleAddDesigner} onRemove={handleRemoveDesigner} />
              {deletedStack.length > 0 && (
                <button onClick={handleUndo}
                  className="mt-3 text-xs px-3 py-1 border border-amber-200 rounded text-amber-600 hover:bg-amber-50 transition-colors">
                  ↩ Undo remove &quot;{deletedStack[deletedStack.length - 1].designer.name}&quot;
                </button>
              )}
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200">
          {([['schedule', 'Weekly Schedule'], ['queue', 'Queue & Turnaround'], ['monthly', 'Monthly Summary']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setActiveTab(id)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}>{label}</button>
          ))}
        </div>

        {/* ── WEEKLY SCHEDULE TAB ── */}
        {activeTab === 'schedule' && (
          <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-wrap gap-2">
              <div className="flex items-center gap-4">
                <h2 className="text-sm font-semibold text-slate-700">Hours per designer per week</h2>
                {hasRates && (
                  <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                    <input type="checkbox" checked={showCPO} onChange={e => setShowCPO(e.target.checked)} className="rounded" />
                    Show CPO
                  </label>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setWeekOffset(Math.max(0, weekOffset - WINDOW))} disabled={weekOffset === 0}
                  className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
                <span className="text-xs text-slate-400">Weeks {weekOffset + 1}–{Math.min(weekOffset + WINDOW, WEEKS)} of {WEEKS}</span>
                <button onClick={() => setWeekOffset(Math.min(WEEKS - WINDOW, weekOffset + WINDOW))} disabled={weekOffset + WINDOW >= WEEKS}
                  className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 w-36 whitespace-nowrap">Designer</th>
                    <th className="px-2 py-2 text-center font-medium text-slate-400 w-12">Ratio</th>
                    <th className="px-2 py-2 text-center font-medium text-slate-400 w-20">Pay</th>
                    {windowWeeks.map(w => (
                      <th key={w} className="px-2 py-2 text-center font-medium text-slate-500 min-w-[96px] whitespace-nowrap">
                        <div>{getWeekLabel(w)}</div>
                        <div className="text-[10px] text-indigo-500 font-normal mt-0.5">
                          {Math.round(weeklyTotals[w].totalFrames)}f
                          {showCPO && hasRates && weeklyTotals[w].totalCPO !== null && (
                            <span className="text-amber-600 ml-1">· {fmt$(weeklyTotals[w].totalCPO!)}</span>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {designers.map((d, di) => (
                    <tr key={d.id} className={`${di % 2 === 0 ? '' : 'bg-slate-50/40'} ${d.payType === 'salary' ? 'bg-amber-50/20' : ''}`}>
                      <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap">
                        <span className="font-medium text-slate-700">{d.name}</span>
                        {d.payType === 'salary' && <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-700 rounded px-1 py-px">salary</span>}
                      </td>
                      <td className="px-2 py-2 text-center text-slate-400">{d.ratio}</td>
                      <td className="px-2 py-2 text-center text-[10px] text-slate-400">
                        {d.payType === 'salary' ? (d.annualSalary > 0 ? fmt$(d.annualSalary) + '/yr' : '—') : (d.hourlyRate > 0 ? '$' + d.hourlyRate + '/hr' : '—')}
                      </td>
                      {windowWeeks.map(w => {
                        const { hrs, frames, cost, cpo } = weekStats(w, d);
                        return (
                          <td key={w} className="px-2 py-1.5 text-center">
                            <input type="number" value={hrs || ''} min="0" step="1" placeholder="—"
                              onChange={e => handleHoursChange(w, d.id, e.target.value)}
                              onContextMenu={e => { e.preventDefault();
                                if (!window.confirm(`Copy ${hrs} hours to all 52 weeks for ${d.name}?`)) return;
                                applyToAllWeeks(d.id, hrs);
                              }}
                              className="w-14 text-center border border-slate-200 rounded px-1 py-1 text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                              title="Right-click to apply to all weeks" />
                            {frames > 0 && (
                              <div className="text-[10px] mt-0.5 space-y-px">
                                <div className="text-slate-400">{Math.round(frames * 10) / 10}f</div>
                                {showCPO && cost > 0 && cpo !== null && <div className="text-amber-600">{fmt$(cpo)}</div>}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="border-t-2 border-indigo-100 bg-indigo-50/40">
                    <td className="sticky left-0 bg-indigo-50/40 px-4 py-2 font-semibold text-indigo-700">Total</td>
                    <td /><td />
                    {windowWeeks.map(w => {
                      const { totalFrames, totalCost, totalCPO } = weeklyTotals[w];
                      return (
                        <td key={w} className="px-2 py-2 text-center">
                          <div className="font-semibold text-indigo-700">{Math.round(totalFrames)}f</div>
                          {showCPO && hasRates && totalCost > 0 && <div className="text-[10px] text-slate-500">{fmt$(totalCost)}</div>}
                          {showCPO && hasRates && totalCPO !== null && <div className="text-[10px] font-semibold text-amber-700">CPO {fmt$(totalCPO)}</div>}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── QUEUE & TURNAROUND TAB ── */}
        {activeTab === 'queue' && (
          <div className="space-y-6">

            {/* Section 1: Future turnaround by intake week */}
            <div className="bg-white border border-slate-100 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-slate-700 mb-1">Future turnaround — orders arriving each week</h2>
              <p className="text-xs text-slate-400 mb-1">
                For bouquets received in a future week: estimated total weeks from bouquet received to frame completed.
                Includes fixed {PRESERVATION_WEEKS}-week preservation pipeline.
              </p>
              <p className="text-xs text-amber-600 mb-4">
                Under 8 weeks total = overstaffed (designing faster than flowers can dry).
              </p>
              <div className="space-y-2.5">
                {futureTurnarounds.slice(0, 20).map((designWait, w) => {
                  const total       = designWait; // already includes preservation weeks
                  const overstaffed = total !== null && total < 8;
                  const { bar, text, label } = turnaroundColors(total, overstaffed);
                  return (
                    <div key={w} className="flex items-center gap-3">
                      <span className="text-xs text-slate-500 w-24 shrink-0">{getWeekLabel(w)}</span>
                      {total !== null ? (
                        <>
                          <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                            <div className="h-2 flex rounded-full overflow-hidden" style={{ width: `${Math.min(100, (total / 22) * 100)}%` }}>
                              <div className="bg-slate-300 shrink-0" style={{ width: `${(PRESERVATION_WEEKS / total) * 100}%` }} />
                              <div className={`${bar} flex-1`} />
                            </div>
                          </div>
                          <span className={`text-xs font-medium w-44 text-right shrink-0 ${text}`}>{label}</span>
                        </>
                      ) : (
                        <span className="text-xs text-red-600 italic">queue not cleared in 52 wks</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-4 mt-5 pt-4 border-t border-slate-100 flex-wrap">
                <span className="flex items-center gap-1.5 text-xs text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-slate-300 inline-block" /> 6 wks preservation</span>
                <span className="flex items-center gap-1.5 text-xs text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block" /> &lt;8 wks — overstaffed</span>
                <span className="flex items-center gap-1.5 text-xs text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" /> 8–10 wks — ideal</span>
                <span className="flex items-center gap-1.5 text-xs text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> 11–18 wks — backlog</span>
                <span className="flex items-center gap-1.5 text-xs text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-red-600 inline-block" /> &gt;18 wks — large backlog</span>
              </div>
            </div>

            {/* Section 2: Historical weeks remaining */}
            <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100">
                <h2 className="text-sm font-semibold text-slate-700">Weeks remaining until design — past intake cohorts</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  For bouquets already received: estimated weeks from today until their cohort reaches the front of the FIFO design queue.
                  Based on {location} designable queue of {designableQueue} orders and scheduled capacity.
                </p>
              </div>
              {location !== 'Utah' ? (
                <p className="px-5 py-4 text-sm text-slate-400 italic">Historical intake data available for Utah only.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-100">
                        <th className="px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap">Intake week</th>
                        <th className="px-3 py-2 text-right font-medium text-slate-500">Received</th>
                        <th className="px-3 py-2 text-right font-medium text-slate-500">Status</th>
                        <th className="px-3 py-2 text-left font-medium text-slate-500">Weeks until designed</th>
                        <th className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap">Total to design</th>
                        <th className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap">Total w/ fulfillment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicalRemaining.map((row, i) => {
                        const inPres    = 'inPreservation' in row && row.inPreservation;
                        const done      = 'alreadyDone' in row && row.alreadyDone;
                        const weeksLeft = row.weeksFromNow;
                        const weeksElapsed = Math.round((getMondayDate(0).getTime() - new Date(row.weekOf + 'T12:00:00').getTime()) / (7 * 24 * 60 * 60 * 1000));
                        // For in-preservation: weeksLeft = when fully designed, weeksElapsed already counted
                        const totalToDesign = (!done && weeksLeft !== null) ? weeksElapsed + weeksLeft : null;
                        const totalWithFulfillment = totalToDesign !== null ? totalToDesign + 2 : null;
                        return (
                          <tr key={i} className={`border-b border-slate-50 ${
                            done       ? 'bg-slate-50 opacity-50' :
                            inPres     ? 'bg-green-50/30' :
                            weeksLeft === 0 ? 'bg-indigo-50/40' :
                            'hover:bg-slate-50'
                          }`}>
                            <td className="px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                              {fmtDate(row.weekOf)}
                              {done && <span className="ml-2 text-[10px] bg-slate-200 text-slate-500 rounded px-1 py-px">✓ designed</span>}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600">
                              {UTAH_HISTORICAL_INTAKE.find(h => h.weekOf === row.weekOf)?.actual ?? '—'}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {done ? (
                                <span className="text-slate-400 text-[10px]">complete</span>
                              ) : inPres ? (
                                <span className="text-green-700 text-[10px] bg-green-100 rounded px-1.5 py-0.5">
                                  still drying — {('preservationWeeksLeft' in row ? (row as {preservationWeeksLeft: number}).preservationWeeksLeft : 0)} wks left
                                </span>
                              ) : weeksLeft === 0 ? (
                                <span className="text-indigo-700 text-[10px] bg-indigo-100 rounded px-1.5 py-0.5">designing now</span>
                              ) : (
                                <span className="text-slate-500 text-[10px]">in design queue</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {done ? (
                                <span className="text-xs text-slate-400 italic">already designed</span>
                              ) : inPres ? (
                                <span className="text-xs text-slate-400 italic">
                                  enters design queue in ~{('preservationWeeksLeft' in row ? (row as {preservationWeeksLeft: number}).preservationWeeksLeft : 0)} wk{('preservationWeeksLeft' in row && (row as {preservationWeeksLeft: number}).preservationWeeksLeft === 1) ? '' : 's'},
                                  then {weeksLeft !== null ? `~${weeksLeft - ('preservationWeeksLeft' in row ? (row as {preservationWeeksLeft: number}).preservationWeeksLeft : 0)} wks in design queue` : 'queue estimate pending'}
                                </span>
                              ) : weeksLeft === null ? (
                                <span className="text-xs text-red-400 italic">not cleared in 52 wks</span>
                              ) : weeksLeft === 0 ? (
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-indigo-200 rounded-full h-1.5 max-w-32">
                                    <div className="h-1.5 rounded-full bg-indigo-500 w-full" />
                                  </div>
                                  <span className="text-xs font-semibold text-indigo-700">this week</span>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-slate-100 rounded-full h-1.5 max-w-32">
                                    <div className={`h-1.5 rounded-full ${weeksLeft <= 4 ? 'bg-green-400' : weeksLeft <= 8 ? 'bg-amber-400' : weeksLeft <= 14 ? 'bg-orange-400' : 'bg-red-500'}`}
                                      style={{ width: `${Math.min(100, (weeksLeft / 16) * 100)}%` }} />
                                  </div>
                                  <span className={`text-xs font-medium whitespace-nowrap ${weeksLeft <= 4 ? 'text-green-700' : weeksLeft <= 8 ? 'text-amber-700' : weeksLeft <= 14 ? 'text-orange-700' : 'text-red-700'}`}>
                                    ~{weeksLeft} wk{weeksLeft !== 1 ? 's' : ''} from now
                                  </span>
                                </div>
                              )}
                            </td>
                            {/* Total turnaround to design */}
                            <td className="px-3 py-2 text-center">
                              {totalToDesign !== null ? (
                                <span className={`text-xs font-semibold ${totalToDesign <= 10 ? 'text-green-700' : totalToDesign <= 18 ? 'text-amber-700' : 'text-red-700'}`}>
                                  ~{totalToDesign} wks
                                </span>
                              ) : done ? (
                                <span className="text-xs text-slate-300">—</span>
                              ) : (
                                <span className="text-xs text-slate-400">TBD</span>
                              )}
                            </td>
                            {/* Total turnaround w/ fulfillment */}
                            <td className="px-3 py-2 text-center">
                              {totalWithFulfillment !== null ? (
                                <span className={`text-xs font-semibold ${totalWithFulfillment <= 12 ? 'text-green-700' : totalWithFulfillment <= 20 ? 'text-amber-700' : 'text-red-700'}`}>
                                  ~{totalWithFulfillment} wks
                                </span>
                              ) : done ? (
                                <span className="text-xs text-slate-300">—</span>
                              ) : (
                                <span className="text-xs text-slate-400">TBD</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── MONTHLY SUMMARY TAB ── */}
        {activeTab === 'monthly' && (
          <div className="space-y-6">
            <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100">
                <h2 className="text-sm font-semibold text-slate-700">Monthly summary</h2>
                <p className="text-xs text-slate-400 mt-0.5">Each week attributed to the month of its Monday. Monthly ratio = total hours ÷ total frames.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="px-4 py-2 text-left font-medium text-slate-500">Month</th>
                      <th className="px-3 py-2 text-right font-medium text-slate-500">Weeks</th>
                      <th className="px-3 py-2 text-right font-medium text-slate-500">Total frames</th>
                      <th className="px-3 py-2 text-right font-medium text-slate-500">Total hours</th>
                      <th className="px-3 py-2 text-right font-medium text-slate-500">Monthly ratio</th>
                      {hasRates && <th className="px-3 py-2 text-right font-medium text-slate-500">Total labor</th>}
                      {hasRates && <th className="px-3 py-2 text-right font-medium text-slate-500">Monthly CPO</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {monthlyData.map((m, i) => (
                      <tr key={m.monthKey} className={`border-b border-slate-50 ${i === 0 ? 'bg-indigo-50/40' : 'hover:bg-slate-50'}`}>
                        <td className="px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                          {m.monthKey}
                          {i === 0 && <span className="ml-2 text-[10px] bg-indigo-100 text-indigo-600 rounded px-1 py-px">current</span>}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-500">{m.weeks}</td>
                        <td className="px-3 py-2 text-right font-medium text-indigo-700">{Math.round(m.totalFrames)}</td>
                        <td className="px-3 py-2 text-right text-slate-500">{Math.round(m.totalHours)}</td>
                        <td className="px-3 py-2 text-right font-medium text-slate-700">
                          {m.monthlyRatio !== null ? `${Math.round(m.monthlyRatio * 100) / 100} hrs/frame` : '—'}
                        </td>
                        {hasRates && <td className="px-3 py-2 text-right text-slate-500">{m.totalCost > 0 ? fmt$(m.totalCost) : '—'}</td>}
                        {hasRates && <td className="px-3 py-2 text-right font-medium text-amber-700">{m.monthlyCPO !== null ? fmt$(m.monthlyCPO) : '—'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100">
                <h2 className="text-sm font-semibold text-slate-700">Per-designer monthly breakdown</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap">Designer</th>
                      {monthlyData.slice(0, 6).map(m => (
                        <th key={m.monthKey} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[120px]">
                          {m.monthKey.split(' ')[0]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {designers.map((d, di) => (
                      <tr key={d.id} className={di % 2 === 0 ? '' : 'bg-slate-50/40'}>
                        <td className="sticky left-0 bg-inherit px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                          {d.name}
                          {d.payType === 'salary' && <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-700 rounded px-1 py-px">salary</span>}
                        </td>
                        {monthlyData.slice(0, 6).map(m => {
                          const s = m.byDesigner[d.id];
                          if (!s || s.frames === 0) return <td key={m.monthKey} className="px-3 py-2 text-center text-slate-200">—</td>;
                          const mCPO = s.cost > 0 && s.frames > 0 ? s.cost / s.frames : null;
                          return (
                            <td key={m.monthKey} className="px-3 py-2 text-center">
                              <div className="font-medium text-indigo-700">{Math.round(s.frames)}f</div>
                              <div className="text-slate-400">{Math.round(s.hrs)}h</div>
                              {hasRates && mCPO !== null && <div className="text-amber-600">{fmt$(mCPO)}</div>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
