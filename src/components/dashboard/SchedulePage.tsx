'use client';
import ResinPage, { DEFAULT_RESIN_ROSTER, type ResinMember } from './ResinPage';
import { RipplingUpload } from './RipplingUpload';
import { EmployeeAutocomplete } from './EmployeeAutocomplete';
import type { RipplingEmployee } from './EmployeeAutocomplete';

import { useState, useEffect, useMemo, useRef } from 'react';
import { HistoricalsSection } from './HistoricalsSection';
import { DisapprovalRateSection } from './DisapprovalRateSection';
import {
  useKpiMetrics, getWindowsByType, selectLocation, selectDept, selectEstimated,
  fmtRatio, fmtCPO, fmtUnits, DEPT_LABELS, DEPT_PRODUCTION_UNIT,
  type KpiDept, type KpiLocation, type KpiState,
} from '@/hooks/useKpiMetrics';
import { useScheduleSettings, usePaidHolidays } from './useScheduleSettings';
import { getMondayDate, isoMonday, getWeekLabel, getMonthKey } from '@/lib/weekDates';
import { InputModeToggle, round2, hoursFromOutput, type InputMode } from './InputModeToggle';
import { distributeHours, resolveDayHours, resolveWeekHours, baseDailyArray, WEEKDAY_LABELS, type DailyHoursMap } from '@/lib/scheduleResolution';
import { BloomUpdateModal, BloomHistoryModal, type BloomUpdateRow } from './BloomUpdateModal';
import { EmploymentDatesEditor } from './EmploymentDatesEditor';

// ─── Types ─────────────────────────────────────────────────────────────────────

type PayType = 'hourly' | 'salary';

interface Designer {
  id:           string;
  name:         string;
  ratio:        number;
  payType:      PayType;
  hourlyRate:   number;
  annualSalary: number;
  isManager?:   boolean;
  role?:        'specialist' | 'senior' | 'master';
}

interface WeekSchedule {
  [designerId: string]: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const WEEKS              = 52;
const WINDOW             = 8;
const PRESERVATION_WEEKS = 8;
const DESIGN_TARGET_MAX      = 14;
// Ratio assumed for a hypothetical new hire on the Queue & Turnaround planner —
// a specialist pace, not the team's blended average, since a new hire isn't
// presumed to start at whatever mix of senior/junior ratios happens to be
// scheduled that week.
const NEW_HIRE_RATIO = 2.0;
// Default projection ratio for auto-filled "bouquets received" estimates:
// same week last year × this multiplier. Editable per week.
const DEFAULT_INTAKE_MULTIPLIER = 1.2;
// Orders shouldn't sit in Fulfillment longer than this once they leave Design.
const FF_TARGET_WEEKS = 2;
// Pace assumed for a hypothetical new fulfillment hire on the Queue &
// Turnaround planner — a fast specialist (see the 0.35–0.5 h/order
// performers on the real rosters), not the team's blended average, for the
// same reason as NEW_HIRE_RATIO above.
const FF_NEW_HIRE_RATIO = 0.5;
// Preservation should ideally receive/log each week's bouquets within that
// same week — any week that isn't fully caught up by the following week is
// already a meaningful red flag, so the target here is tight relative to
// Design/Fulfillment's multi-week targets.
const PRES_TARGET_WEEKS = 1;
const PRES_NEW_HIRE_RATIO = 0.6;

// ─── Historical Utah intake (actual received by week) ─────────────────────────
// Calibration for the designed-to-date anchor: frames designed before design-historicals
// coverage began (Dec 29, 2025). Can be negative — it also absorbs frames-vs-bouquet unit
// differences. Utah calibrated Jun 10, 2026 so the queue front = Mar 16 intake week.
// Georgia recalibrated Aug 10, 2026 (design team confirmed front = May 18 intake
// week; the Aug 4 calibration to May 4 was based on a bad update and drifted
// ~2 weeks behind reality).
const DESIGNED_BASELINE: Record<'Utah' | 'Georgia', number> = { Utah: -636, Georgia: 51 };

const UTAH_HISTORICAL_INTAKE: { weekOf: string; actual: number }[] = [
  { weekOf: '2025-09-29', actual: 187 },
  { weekOf: '2025-10-06', actual: 167 },
  { weekOf: '2025-10-13', actual: 192 },
  { weekOf: '2025-10-20', actual: 159 },
  { weekOf: '2025-10-27', actual: 139 },
  { weekOf: '2025-11-03', actual: 97  },
  { weekOf: '2025-11-10', actual: 110 },
  { weekOf: '2025-11-17', actual: 68  },
  { weekOf: '2025-11-24', actual: 39  },
  { weekOf: '2025-12-01', actual: 15  },
  { weekOf: '2025-12-08', actual: 29  },
  { weekOf: '2025-12-15', actual: 41  },
  { weekOf: '2025-12-22', actual: 16  },
  { weekOf: '2025-12-29', actual: 24  },
  { weekOf: '2026-01-05', actual: 22  },
  { weekOf: '2026-01-12', actual: 18  },
  { weekOf: '2026-01-19', actual: 22  },
  { weekOf: '2026-01-26', actual: 12  },
  { weekOf: '2026-02-02', actual: 10  },
  { weekOf: '2026-02-09', actual: 25  },
  { weekOf: '2026-02-16', actual: 27  },
  { weekOf: '2026-02-23', actual: 24  },
  { weekOf: '2026-03-02', actual: 13  },
  { weekOf: '2026-03-09', actual: 28  },
  { weekOf: '2026-03-16', actual: 47  },
  { weekOf: '2026-03-23', actual: 43  },
  { weekOf: '2026-03-30', actual: 31  },
];

// ─── Historical Georgia intake (actual received by week) ──────────────────────
const GEORGIA_HISTORICAL_INTAKE: { weekOf: string; actual: number }[] = [
  { weekOf: '2025-09-22', actual: 67  }, // wk 39
  { weekOf: '2025-09-29', actual: 176 }, // wk 40
  { weekOf: '2025-10-06', actual: 200 }, // wk 41
  { weekOf: '2025-10-13', actual: 170 }, // wk 42
  { weekOf: '2025-10-20', actual: 165 }, // wk 43
  { weekOf: '2025-10-27', actual: 127 }, // wk 44
  { weekOf: '2025-11-03', actual: 105 }, // wk 45
  { weekOf: '2025-11-10', actual: 137 }, // wk 46
  { weekOf: '2025-11-17', actual: 95  }, // wk 47
  { weekOf: '2025-11-24', actual: 57  }, // wk 48
  { weekOf: '2025-12-01', actual: 40  }, // wk 49
  { weekOf: '2025-12-08', actual: 47  }, // wk 50
  { weekOf: '2025-12-15', actual: 66  }, // wk 51
  { weekOf: '2025-12-22', actual: 33  }, // wk 52
  { weekOf: '2025-12-29', actual: 41  }, // wk 1 2026
  { weekOf: '2026-01-05', actual: 35  }, // wk 2
  { weekOf: '2026-01-12', actual: 16  }, // wk 3
  { weekOf: '2026-01-19', actual: 31  }, // wk 4
  { weekOf: '2026-01-26', actual: 12  }, // wk 5
  { weekOf: '2026-02-02', actual: 31  }, // wk 6
  { weekOf: '2026-02-09', actual: 23  }, // wk 7
  { weekOf: '2026-02-16', actual: 27  }, // wk 8
  { weekOf: '2026-02-23', actual: 30  }, // wk 9
  { weekOf: '2026-03-02', actual: 32  }, // wk 10
  { weekOf: '2026-03-09', actual: 48  }, // wk 11
  { weekOf: '2026-03-16', actual: 63  }, // wk 12
  { weekOf: '2026-03-23', actual: 49  }, // wk 13
  { weekOf: '2026-03-30', actual: 56  }, // wk 14 (current, projected)
];

// ─── Default designers ────────────────────────────────────────────────────────

const DEFAULT_UTAH_DESIGNERS: Designer[] = [
  { id: 'ut-mgr', name: 'Jennika Merrill',  ratio: 1.4, payType: 'salary', hourlyRate: 0, annualSalary: 0, isManager: true, role: 'master' as const },
  { id: 'ut-1',   name: 'Deanna Haug',   ratio: 1.6, payType: 'hourly', hourlyRate: 0, annualSalary: 0, role: 'senior' as const },
  { id: 'ut-3',   name: 'Kathryn Sonntag',     ratio: 1.4, payType: 'hourly', hourlyRate: 0, annualSalary: 0, role: 'senior' as const },
  { id: 'ut-4',   name: 'Mia Legas Boots',        ratio: 1.2, payType: 'hourly', hourlyRate: 0, annualSalary: 0, role: 'senior' as const },
  { id: 'ut-5',   name: 'Sloane James',     ratio: 1.2, payType: 'hourly', hourlyRate: 0, annualSalary: 0, role: 'senior' as const },
  { id: 'ut-6',   name: 'Audrey Windsor',     ratio: 2.0, payType: 'hourly', hourlyRate: 0, annualSalary: 0, role: 'specialist' as const },
  { id: 'ut-7',   name: 'Chloe Jensen',    ratio: 1.6, payType: 'hourly', hourlyRate: 0, annualSalary: 0, role: 'specialist' as const },
];

const DEFAULT_GEORGIA_DESIGNERS: Designer[] = [
  { id: 'ga-1', name: 'Katherine Piper', ratio: 1.6, payType: 'hourly', hourlyRate: 22.50, annualSalary: 0, isManager: true, role: 'master' as const },
  { id: 'ga-2', name: 'Allanna Harlan',  ratio: 1.6, payType: 'hourly', hourlyRate: 0, annualSalary: 0, role: 'senior' as const },
  { id: 'ga-3', name: 'Erin Webb',       ratio: 2.3, payType: 'hourly', hourlyRate: 0, annualSalary: 0, role: 'senior' as const },
  { id: 'ga-4', name: 'Rachel Tucker',   ratio: 2.0, payType: 'hourly', hourlyRate: 0, annualSalary: 0, role: 'specialist' as const },
  { id: 'ga-5', name: 'Celt Stewart',    ratio: 2.0, payType: 'hourly', hourlyRate: 19.50, annualSalary: 0, isManager: true, role: 'master' as const },
];

function buildDefaultUtahSchedule(): WeekSchedule[] {
  return Array.from({ length: WEEKS }, (_, w) => ({
    'ut-mgr': 15,
    'ut-1':   w === 5 ? 0 : 28,
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
    'ga-1': 0, 'ga-2': 0, 'ga-3': 0, 'ga-4': 0, 'ga-5': 0,
  }));
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Returns the past N week Monday ISO dates (most recent first)
function pastWeeks(n: number): string[] {
  return Array.from({ length: n }, (_, i) => isoMonday(-(i + 1)));
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function turnaroundColors(totalWeeks: number | null, overstaffed: boolean) {
  if (totalWeeks === null) return { bar: 'bg-red-400',    text: 'text-red-700',    label: 'queue not cleared in 52 wks' };
  if (overstaffed)         return { bar: 'bg-orange-400', text: 'text-orange-700', label: `~${totalWeeks} wks — overstaffed` };
  if (totalWeeks <= 10)    return { bar: 'bg-green-400',  text: 'text-green-700',  label: `~${totalWeeks} wks — ideal` };
  if (totalWeeks <= 18)    return { bar: 'bg-amber-400',  text: 'text-amber-700',  label: `~${totalWeeks} wks — backlog building` };
  return                          { bar: 'bg-red-600',    text: 'text-red-800',    label: `~${totalWeeks} wks — large backlog` };
}

// Same idea as turnaroundColors, but banded around the 2-week Fulfillment
// target instead of Design's 10/18-week bands — amber kicks in a week before
// the target is actually breached, so there's still time to react.
function fulfillmentTurnaroundColors(totalWeeks: number | null) {
  if (totalWeeks === null) return { bar: 'bg-red-600',   text: 'text-red-800',   label: 'queue not cleared in 52 wks' };
  if (totalWeeks <= 1)     return { bar: 'bg-green-400', text: 'text-green-700', label: `~${totalWeeks}wk — on pace` };
  if (totalWeeks <= FF_TARGET_WEEKS) return { bar: 'bg-amber-400', text: 'text-amber-700', label: `~${totalWeeks}wks — at ${FF_TARGET_WEEKS}wk target` };
  return                          { bar: 'bg-red-600',    text: 'text-red-800',   label: `~${totalWeeks}wks — over ${FF_TARGET_WEEKS}wk target` };
}

// Same idea, banded around Preservation's tighter same-week target.
function preservationTurnaroundColors(totalWeeks: number | null) {
  if (totalWeeks === null)  return { bar: 'bg-red-600',   text: 'text-red-800',   label: 'queue not cleared in 52 wks' };
  if (totalWeeks <= 0)      return { bar: 'bg-green-400', text: 'text-green-700', label: 'keeping pace' };
  if (totalWeeks <= PRES_TARGET_WEEKS) return { bar: 'bg-amber-400', text: 'text-amber-700', label: `~${totalWeeks}wk behind` };
  return                           { bar: 'bg-red-600',   text: 'text-red-800',   label: `~${totalWeeks}wks behind — backlog building` };
}

// Pure FIFO simulation: given a starting designable queue, a per-week inflow of
// cohorts graduating out of preservation, and a per-week design capacity (frames),
// returns for each week w the total weeks (received → frame completed) for a bouquet
// received in week w — or null if the queue never clears within the horizon.
// Shared by the live turnaround projection and the capacity-goal solver below so
// both always agree on how capacity translates into turnaround.
function simulateDesignTurnarounds(startQueue: number, graduatingByWeek: number[], frameCapacityByWeek: number[]): (number | null)[] {
  const weeks = frameCapacityByWeek.length;
  const queueAtStart: number[] = [startQueue];
  for (let w = 0; w < weeks - 1; w++) {
    const afterDrain    = Math.max(0, queueAtStart[w] - frameCapacityByWeek[w]);
    const afterGraduate = afterDrain + (graduatingByWeek[w + 1] ?? 0);
    queueAtStart.push(afterGraduate);
  }
  return Array.from({ length: weeks }, (_, w) => {
    const graduateWeek = w + PRESERVATION_WEEKS;
    if (graduateWeek >= weeks) return null;
    const queueAhead = queueAtStart[graduateWeek];
    const cohortSize = graduatingByWeek[w] ?? 0;
    let remaining    = queueAhead + cohortSize;
    for (let fw = graduateWeek; fw < weeks; fw++) {
      remaining -= frameCapacityByWeek[fw];
      if (remaining <= 0) return fw - w;
    }
    return null;
  });
}

// Same simulation, but treats each cohort as competing for capacity starting
// in its own intake week instead of PRESERVATION_WEEKS later — i.e. pretends
// there's no mandatory drying wait. Never used to decide anything real (a
// bouquet genuinely can't be designed before it finishes drying, so the real
// turnaround can never read below PRESERVATION_WEEKS) — purely a "how
// overstaffed are we" gauge for weeks that have already hit that floor,
// where the real number would otherwise just repeat PRESERVATION_WEEKS with
// no sense of degree.
function simulateDesignTurnaroundsUnclamped(startQueue: number, graduatingByWeek: number[], frameCapacityByWeek: number[]): (number | null)[] {
  const weeks = frameCapacityByWeek.length;
  const queueAtStart: number[] = [startQueue];
  for (let w = 0; w < weeks - 1; w++) {
    const afterDrain    = Math.max(0, queueAtStart[w] - frameCapacityByWeek[w]);
    const afterGraduate = afterDrain + (graduatingByWeek[w + 1] ?? 0);
    queueAtStart.push(afterGraduate);
  }
  return Array.from({ length: weeks }, (_, w) => {
    const queueAhead = queueAtStart[w];
    const cohortSize = graduatingByWeek[w] ?? 0;
    let remaining    = queueAhead + cohortSize;
    for (let fw = w; fw < weeks; fw++) {
      remaining -= frameCapacityByWeek[fw];
      if (remaining <= 0) return fw - w;
    }
    return null;
  });
}

// ─── RosterEditor ──────────────────────────────────────────────────────────────

function RosterEditor({ designers, onChange, onAdd, onRemove, onReorder, location, standardWeeklyHoursById, onTemplateChange, onResetToTemplate, employmentById, onEmploymentChange }: {
  designers: Designer[];
  onChange:  (id: string, field: keyof Designer, value: string) => void;
  onAdd:     () => void;
  onRemove:  (id: string) => void;
  onReorder?: (newOrder: string[]) => void;
  location?: string;
  standardWeeklyHoursById: Record<string, number[] | undefined>;
  onTemplateChange: (id: string, dayIdx: number, value: number) => void;
  onResetToTemplate?: (id: string) => void;
  employmentById: Record<string, { startDate?: string; endDate?: string } | undefined>;
  onEmploymentChange: (id: string, field: 'startDate' | 'endDate', value: string) => void;
}) {
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  async function refreshRatio(d: Designer) {
    setRefreshingId(d.id);
    try {
      const res = await fetch(`/api/actuals?location=${location ?? 'Utah'}&type=team&weeks=100`);
      const data = await res.json() as { teamActuals?: { department: string; week_of: string; member_name: string; actual_hours: number; actual_orders: number }[] };
      const rows = (data.teamActuals ?? [])
        .filter(r => r.department === 'design' && r.member_name === d.name)
        .sort((a, b) => b.week_of.localeCompare(a.week_of))
        .slice(0, 4);
      const totalHours  = rows.reduce((s, r) => s + r.actual_hours,  0);
      const totalOrders = rows.reduce((s, r) => s + r.actual_orders, 0);
      if (totalOrders > 0 && totalHours > 0) {
        onChange(d.id, 'ratio', (Math.round(totalHours / totalOrders * 100) / 100).toString());
      }
    } catch {}
    setRefreshingId(null);
  }
  return (
    <div>
      <div className="grid grid-cols-[1fr_80px_90px_20px] gap-2 mb-2 px-1 text-xs font-medium text-slate-400">
        <span>Name</span>
        <span className="text-center">Role</span>
        <span className="text-center">Ratio</span>
        <span />
      </div>
      <div className="space-y-3">
        {designers.map(d => {
          const template = standardWeeklyHoursById[d.id];
          return (
          <div key={d.id} className="space-y-1.5">
            <div className="grid grid-cols-[1fr_80px_90px_20px] gap-2 items-center">
              <div className="flex items-center gap-1.5 min-w-0">
                <div className="flex-1 min-w-0">
                  <EmployeeAutocomplete
                    value={d.name}
                    location={location ?? 'Utah'}
                    department="Design"
                    onChange={val => onChange(d.id, 'name', val)}
                    onSelect={(emp: RipplingEmployee) => { onChange(d.id, 'name', emp.full_name); onChange(d.id, 'role', emp.role); onChange(d.id, 'hourlyRate', String(emp.hourly_rate ?? 0)); onChange(d.id, 'payType', emp.pay_type); onChange(d.id, 'annualSalary', String(emp.annual_salary ?? 0)); }}
                  />
                </div>
                {(d as {isManager?:boolean}).isManager && (
                  <span className="shrink-0 text-[9px] font-medium text-violet-600 bg-violet-50 border border-violet-200 rounded px-1.5 py-0.5">Manager</span>
                )}
              </div>
              <select value={(d as {role?:string}).role ?? 'specialist'} onChange={e => onChange(d.id, 'role', e.target.value)}
                className="border border-slate-200 rounded px-1.5 py-1.5 text-xs text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300">
                <option value="specialist">Specialist</option>
                <option value="senior">Senior</option>
                <option value="master">Master</option>
              </select>
              <div className="flex items-center gap-1">
                <input type="number" value={d.ratio} step="0.1" min="0.1"
                  onChange={e => onChange(d.id, 'ratio', e.target.value)}
                  className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                <button onClick={() => refreshRatio(d)} title="Update ratio from last 4 weeks of historicals"
                  className="text-slate-300 hover:text-indigo-500 transition-colors text-sm shrink-0"
                  disabled={refreshingId === d.id}>
                  {refreshingId === d.id ? '…' : '↻'}
                </button>
              </div>
              <button onClick={() => onRemove(d.id)} className="text-slate-300 hover:text-red-400 transition-colors text-xl leading-none text-center">×</button>
            </div>
            <div className="flex items-center gap-1.5 pl-1">
              <span className="text-[10px] text-slate-400 w-32 shrink-0">
                Standard schedule{!template && <span className="text-amber-500"> — not set</span>}
              </span>
              {WEEKDAY_LABELS.map((label, di) => (
                <label key={di} className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-slate-300">{label[0]}</span>
                  <input type="number" min="0" step="0.5" placeholder="0"
                    value={template?.[di] || ''}
                    onChange={e => onTemplateChange(d.id, di, parseFloat(e.target.value) || 0)}
                    title={`${label} standard hours`}
                    className="w-10 border border-slate-200 rounded px-1 py-0.5 text-center text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                </label>
              ))}
              {onResetToTemplate && (
                <button onClick={() => onResetToTemplate(d.id)}
                  title="Clear scheduled hours from this week forward and go back to following this template"
                  className="text-[10px] text-slate-400 hover:text-indigo-600 whitespace-nowrap ml-1">
                  ↺ Reset to template
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5 pl-1">
              <span className="text-[10px] text-slate-400 w-32 shrink-0">Employment dates</span>
              <EmploymentDatesEditor
                startDate={employmentById[d.id]?.startDate}
                endDate={employmentById[d.id]?.endDate}
                onStartDateChange={val => onEmploymentChange(d.id, 'startDate', val)}
                onEndDateChange={val => onEmploymentChange(d.id, 'endDate', val)}
              />
            </div>
          </div>
          );
        })}
      </div>
      <button onClick={onAdd}
        className="mt-3 text-xs px-3 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 transition-colors">
        + Add designer
      </button>
      <p className="mt-3 text-xs text-slate-400">Pay rates &amp; titles come from Rippling upload. Ratio = hours per frame.</p>
    </div>
  );
}

// ─── HistoricalsTab ────────────────────────────────────────────────────────────

function HistoricalsTab({ designers, location, teamActuals, onActualsSaved, canViewCPO = true }: {
  designers:      Designer[];
  location:       'Utah' | 'Georgia';
  teamActuals:    { department: string; week_of: string; member_name: string; actual_hours: number; actual_orders: number }[];
  onActualsSaved: () => void;
  canViewCPO?:    boolean;
}) {
  const HIST_WEEKS  = 12;
  const weekOptions = pastWeeks(HIST_WEEKS);
  const [selectedWeek, setSelectedWeek] = useState(weekOptions[0]);
  const [saving,       setSaving]       = useState(false);
  const [saveMsg,      setSaveMsg]      = useState('');

  // Local edits before saving
  const [localEdits, setLocalEdits] = useState<Record<string, { hours: number; frames: number }>>({});

  // Merge Supabase actuals with local edits for display
  function getEntry(designerId: string, name: string) {
    if (localEdits[designerId]) return localEdits[designerId];
    const row = teamActuals.find(r =>
      r.department === 'design' &&
      r.week_of === selectedWeek &&
      r.member_name === name
    );
    return { hours: row?.actual_hours ?? 0, frames: row?.actual_orders ?? 0 };
  }

  function setEntry(designerId: string, field: 'hours' | 'frames', val: number) {
    setLocalEdits(prev => ({
      ...prev,
      [designerId]: { ...getEntry(designerId, designers.find(d => d.id === designerId)?.name ?? ''), [field]: val },
    }));
  }

  async function saveWeek() {
    setSaving(true);
    setSaveMsg('');
    try {
      const saves = designers.map(d => {
        const entry = getEntry(d.id, d.name);
        if (entry.hours === 0 && entry.frames === 0) return Promise.resolve();
        return fetch('/api/actuals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'team', location, weekOf: selectedWeek,
            department: 'design', memberName: d.name,
            actualHours: entry.hours, actualOrders: entry.frames,
          }),
        });
      });
      await Promise.all(saves);
      setLocalEdits({});
      setSaveMsg('Saved');
      onActualsSaved();
      setTimeout(() => setSaveMsg(''), 2000);
    } catch { setSaveMsg('Save failed'); }
    setSaving(false);
  }

  const weekData = designers.map(d => {
    const entry = getEntry(d.id, d.name);
    const ratio = entry.hours > 0 && entry.frames > 0 ? entry.hours / entry.frames : null;
    const cost  = d.payType === 'salary' ? d.annualSalary / 52 : entry.hours * d.hourlyRate;
    const cpo   = entry.frames > 0 && cost > 0 ? cost / entry.frames : null;
    return { designer: d, hours: entry.hours, frames: entry.frames, ratio, cost, cpo };
  });

  const teamFrames = weekData.reduce((s, r) => s + r.frames, 0);
  const teamHours  = weekData.reduce((s, r) => s + r.hours,  0);
  const teamCost   = weekData.reduce((s, r) => s + r.cost,   0);
  const teamRatio  = teamFrames > 0 && teamHours > 0 ? teamHours / teamFrames : null;
  const teamCPO    = teamFrames > 0 && teamCost  > 0 ? teamCost  / teamFrames : null;
  const hasCost    = canViewCPO && designers.some(d =>
    (d.payType === 'hourly' && d.hourlyRate > 0) || (d.payType === 'salary' && d.annualSalary > 0)
  );

  // Monthly summary across all loaded actuals
  const monthlyByDesigner = useMemo(() => {
    const map: Record<string, Record<string, { frames: number; hours: number; cost: number }>> = {};
    teamActuals
      .filter(r => r.department === 'design')
      .forEach(r => {
        const monthKey = new Date(r.week_of + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const d = designers.find(d => d.name === r.member_name);
        if (!d) return;
        if (!map[monthKey]) map[monthKey] = {};
        if (!map[monthKey][d.id]) map[monthKey][d.id] = { frames: 0, hours: 0, cost: 0 };
        map[monthKey][d.id].frames += r.actual_orders;
        map[monthKey][d.id].hours  += r.actual_hours;
        map[monthKey][d.id].cost   += r.actual_hours * (d.hourlyRate ?? 0);
      });
    return map;
  }, [teamActuals, designers]);

  return (
    <div className="space-y-5">
      {/* Week selector */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs font-medium text-slate-500">Week of</label>
        <select value={selectedWeek} onChange={e => { setSelectedWeek(e.target.value); setLocalEdits({}); }}
          className="border border-slate-200 rounded px-2 py-1.5 text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300">
          {weekOptions.map(w => (
            <option key={w} value={w}>{fmtDate(w)} – {fmtDate(addDays(w, 6))}</option>
          ))}
        </select>
        <button onClick={() => void saveWeek()} disabled={saving}
          className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 transition-colors">
          {saving ? 'Saving…' : 'Save week actuals'}
        </button>
        {saveMsg && <span className={`text-xs ${saveMsg === 'Saved' ? 'text-green-600' : 'text-red-500'}`}>{saveMsg}</span>}
        <span className="text-xs text-slate-400 italic">Enter actual frames and hours for each designer, then save.</span>
      </div>

      {/* Per-designer actuals table */}
      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Week of {fmtDate(selectedWeek)}</h3>
            <p className="text-xs text-slate-400 mt-0.5">Enter actual frames completed and hours worked. Saved to shared database.</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="px-4 py-2 text-left font-medium text-slate-500">Designer</th>
                <th className="px-3 py-2 text-center font-medium text-slate-500">Actual frames</th>
                <th className="px-3 py-2 text-center font-medium text-slate-500">Actual hours</th>
                <th className="px-3 py-2 text-center font-medium text-slate-500">Actual ratio</th>
                {hasCost && <th className="px-3 py-2 text-center font-medium text-slate-500">Labor cost</th>}
                {hasCost && <th className="px-3 py-2 text-center font-medium text-slate-500">Actual CPO</th>}
              </tr>
            </thead>
            <tbody>
              {weekData.map((row, i) => (
                <tr key={row.designer.id} className={`border-b border-slate-50 ${i % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                  <td className="px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                    {row.designer.name}
                    {row.designer.payType === 'salary' && (
                      <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-700 rounded px-1 py-px">salary</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input type="number" value={row.frames || ''} min="0" placeholder="0"
                      onChange={e => setEntry(row.designer.id, 'frames', parseInt(e.target.value) || 0)}
                      className="w-16 border border-slate-200 rounded px-2 py-1 text-center text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input type="number" value={row.hours || ''} min="0" step="0.5" placeholder="0"
                      onChange={e => setEntry(row.designer.id, 'hours', parseFloat(e.target.value) || 0)}
                      className="w-16 border border-slate-200 rounded px-2 py-1 text-center text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                  </td>
                  <td className="px-3 py-2 text-center">
                    {row.ratio !== null ? (
                      <span className={`font-semibold ${row.ratio <= 1.4 ? 'text-green-700' : row.ratio <= 1.8 ? 'text-amber-700' : 'text-red-700'}`}>
                        {row.ratio.toFixed(2)} h/f
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  {hasCost && <td className="px-3 py-2 text-center text-slate-500">{row.cost > 0 ? fmt$(row.cost) : '—'}</td>}
                  {hasCost && <td className="px-3 py-2 text-center">{row.cpo !== null ? <span className="font-semibold text-amber-700">{fmt$(row.cpo)}</span> : '—'}</td>}
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200 bg-indigo-50/30 font-semibold">
                <td className="px-4 py-2 text-slate-700">Team total</td>
                <td className="px-3 py-2 text-center text-indigo-700">{teamFrames || '—'}</td>
                <td className="px-3 py-2 text-center text-slate-700">{teamHours || '—'}</td>
                <td className="px-3 py-2 text-center">
                  {teamRatio !== null ? <span className={teamRatio <= 1.5 ? 'text-green-700' : teamRatio <= 1.8 ? 'text-amber-700' : 'text-red-700'}>{teamRatio.toFixed(2)} h/f</span> : '—'}
                </td>
                {hasCost && <td className="px-3 py-2 text-center text-slate-600">{teamCost > 0 ? fmt$(teamCost) : '—'}</td>}
                {hasCost && <td className="px-3 py-2 text-center text-amber-700">{teamCPO !== null ? fmt$(teamCPO) : '—'}</td>}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* All-weeks overview */}
      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700">All weeks overview</h3>
          <p className="text-xs text-slate-400 mt-0.5">Populated as you save each week. Shared across all logged-in users.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap">Designer</th>
                {weekOptions.map(w => (
                  <th key={w} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[100px]">
                    {fmtDate(w).split(',')[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {designers.map((d, di) => (
                <tr key={d.id} className={di % 2 === 0 ? '' : 'bg-slate-50/40'}>
                  <td className="sticky left-0 bg-inherit px-4 py-2 font-medium text-slate-700 whitespace-nowrap">{d.name}</td>
                  {weekOptions.map(w => {
                    const row = teamActuals.find(r => r.department === 'design' && r.week_of === w && r.member_name === d.name);
                    if (!row || (row.actual_hours === 0 && row.actual_orders === 0)) {
                      return <td key={w} className="px-3 py-2 text-center text-slate-200">—</td>;
                    }
                    const r = row.actual_hours > 0 && row.actual_orders > 0 ? row.actual_hours / row.actual_orders : null;
                    return (
                      <td key={w} className="px-3 py-2 text-center">
                        <div className="font-medium text-indigo-700">{row.actual_orders}f</div>
                        <div className="text-slate-400">{row.actual_hours}h</div>
                        {r !== null && <div className={r <= 1.5 ? 'text-green-700' : r <= 1.8 ? 'text-amber-700' : 'text-red-700'}>{r.toFixed(2)}</div>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Monthly actuals summary */}
      {Object.keys(monthlyByDesigner).length > 0 && (
        <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-700">Monthly actuals summary</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500">Designer</th>
                  {Object.keys(monthlyByDesigner).sort().map(m => (
                    <th key={m} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[110px]">{m.split(' ')[0]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {designers.map((d, di) => (
                  <tr key={d.id} className={di % 2 === 0 ? '' : 'bg-slate-50/40'}>
                    <td className="sticky left-0 bg-inherit px-4 py-2 font-medium text-slate-700 whitespace-nowrap">{d.name}</td>
                    {Object.keys(monthlyByDesigner).sort().map(m => {
                      const s = monthlyByDesigner[m]?.[d.id];
                      if (!s || s.frames === 0) return <td key={m} className="px-3 py-2 text-center text-slate-200">—</td>;
                      const r = s.hours > 0 && s.frames > 0 ? s.hours / s.frames : null;
                      const cpo = s.cost > 0 && s.frames > 0 ? s.cost / s.frames : null;
                      return (
                        <td key={m} className="px-3 py-2 text-center">
                          <div className="font-medium text-indigo-700">{s.frames}f</div>
                          <div className="text-slate-400">{s.hours}h</div>
                          {r !== null && <div className={r <= 1.5 ? 'text-green-700' : r <= 1.8 ? 'text-amber-700' : 'text-red-700'}>{r.toFixed(2)}</div>}
                          {hasCost && cpo !== null && <div className="text-amber-600">{fmt$(cpo)}</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Preservation team data ────────────────────────────────────────────────────

const UTAH_PRESERVATION_TEAM: PresTeamMember[] = [
  { id: 'ut-p1', name: 'Katelyn Wilson', ratio: 0.7, pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(5).fill(8), isManager: true, role: 'master' as const },
  { id: 'ut-p2', name: 'Emma Dunakey',   ratio: 0.5, pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(5).fill(8), role: 'senior' as const },
  { id: 'ut-p5', name: 'Chloe Jensen',    ratio: 1.0,  pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(5).fill(0), role: 'specialist' as const },
  { id: 'ut-p6', name: 'Audrey Windsor',    ratio: 1.1,  pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(5).fill(0), role: 'specialist' as const },
  { id: 'ut-p7', name: 'Preslee Peterson',  ratio: 0.92, pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(5).fill(0), role: 'specialist' as const },
];

const GEORGIA_PRESERVATION_TEAM: PresTeamMember[] = [
  { id: 'ga-p2', name: 'Celt Stewart',  ratio: 0.5,  pay: 'hourly' as const, payType: 'hourly' as const, rate: 19.50, annualSalary: 0, hours: Array(5).fill(8), isManager: true, role: 'master' as const },
];

const UTAH_FULFILLMENT_TEAM: FfTeamMember[] = [
  { id: 'ut-f1', name: 'Bella DePrima',       ratio: 1.0,  pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(8).fill(8), isManager: true, role: 'master' as const },
  { id: 'ut-f2', name: 'Warner Neuenschwander',  ratio: 0.5,  pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(8).fill(8), role: 'specialist' as const },
  { id: 'ut-f3', name: 'Owen Shaw',              ratio: 0.35, pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(8).fill(8), role: 'senior' as const },
  { id: 'ut-f4', name: 'Emma Van Dyke',           ratio: 0.37, pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(8).fill(8), role: 'senior' as const },
];

const GEORGIA_FULFILLMENT_TEAM: FfTeamMember[] = [
  { id: 'ga-f1', name: 'Yann Jean-Louis', ratio: 2.0,  pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(8).fill(8), isManager: true, role: 'master' as const },
  { id: 'ga-f2', name: 'Nahid Knight',    ratio: 0.75, pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(8).fill(8), role: 'specialist' as const },
  { id: 'ga-f3', name: 'Shantel Phifer',  ratio: 0.61, pay: 'hourly' as const, payType: 'hourly' as const, rate: 0, annualSalary: 0, hours: Array(8).fill(8), role: 'specialist' as const },
];

type PresTeamMember = { id: string; name: string; ratio: number; pay: 'hourly'|'flex'|'oncall'; payType: 'hourly'|'salary'; rate: number; annualSalary: number; hours: number[]; isManager?: boolean; role?: 'specialist'|'senior'|'master' };
type FfTeamMember   = { id: string; name: string; ratio: number; pay: 'hourly'; payType: 'hourly'|'salary'; rate: number; annualSalary: number; hours: number[]; isManager?: boolean; role?: 'specialist'|'senior'|'master' };

// Dynamic week labels — always real Monday dates
function getWeekLabels8(): string[] {
  return Array.from({ length: 8 }, (_, i) =>
    getMondayDate(i).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
}

function parseDateRange(from: string, to: string): Record<string, number> {
  // Returns mock event-date counts for the range — in production this would
  // call /api/event-dates?from=X&to=Y which pulls from EventDateSection data
  const MOCK: Record<string, number> = {
    '2026-04-07':3,'2026-04-08':10,'2026-04-09':1,'2026-04-10':6,
    '2026-04-11':33,'2026-04-12':5,'2026-04-13':1,'2026-04-14':4,
    '2026-04-15':8,'2026-04-16':12,'2026-04-17':7,'2026-04-18':22,
    '2026-04-19':18,'2026-04-20':3,'2026-04-21':9,'2026-04-22':15,
    '2026-04-23':11,'2026-04-24':6,'2026-04-25':14,'2026-04-26':20,
    '2026-04-27':17,'2026-04-28':5,'2026-04-29':8,'2026-04-30':13,
  };
  const result: Record<string, number> = {};
  let d = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  while (d <= end) {
    const iso = d.toISOString().split('T')[0];
    if (MOCK[iso]) result[iso] = MOCK[iso];
    d.setDate(d.getDate() + 1);
  }
  return result;
}

// ─── Per-week CSV historical data — Utah ─────────────────────────────────────
const UTAH_HISTORICALS_BY_WEEK: Record<string, { weekOf: string; members: Record<string, { hours: number; orders: number }> }[]> = {
  fulfillment: [
  { weekOf: '2025-12-29', members: {
    'Owen Shaw': { hours: 6.25, orders: 15 },
    'Emma Swenson': { hours: 0, orders: 0 },
    'Warner Neuenschwander': { hours: 0, orders: 0 },
    'Izabella DePrima': { hours: 2.59, orders: 0 }
  } },
  { weekOf: '2026-01-05', members: {
    'Owen Shaw': { hours: 10.41, orders: 23 },
    'Emma Swenson': { hours: 9.77, orders: 21 },
    'Warner Neuenschwander': { hours: 3.73, orders: 16 },
    'Izabella DePrima': { hours: 40.06, orders: 10 }
  } },
  { weekOf: '2026-01-12', members: {
    'Owen Shaw': { hours: 19.8, orders: 44 },
    'Emma Swenson': { hours: 6.67, orders: 25 },
    'Warner Neuenschwander': { hours: 5.73, orders: 18 },
    'Izabella DePrima': { hours: 33.2, orders: 8 }
  } },
  { weekOf: '2026-01-19', members: {
    'Owen Shaw': { hours: 14.12, orders: 40 },
    'Emma Swenson': { hours: 12.09, orders: 31 },
    'Warner Neuenschwander': { hours: 1.12, orders: 8 },
    'Izabella DePrima': { hours: 39.95, orders: 21 }
  } },
  { weekOf: '2026-01-26', members: {
    'Owen Shaw': { hours: 13.85, orders: 31 },
    'Emma Swenson': { hours: 6.1, orders: 17 },
    'Warner Neuenschwander': { hours: 2.07, orders: 5 },
    'Izabella DePrima': { hours: 28.11, orders: 12 }
  } },
  { weekOf: '2026-02-02', members: {
    'Owen Shaw': { hours: 7.41, orders: 21 },
    'Emma Swenson': { hours: 6.86, orders: 15 },
    'Warner Neuenschwander': { hours: 7.17, orders: 13 },
    'Izabella DePrima': { hours: 6.53, orders: 0 }
  } },
  { weekOf: '2026-02-09', members: {
    'Owen Shaw': { hours: 22.71, orders: 55 },
    'Emma Swenson': { hours: 4.65, orders: 9 },
    'Warner Neuenschwander': { hours: 7.21, orders: 9 },
    'Izabella DePrima': { hours: 39.6, orders: 22 }
  } },
  { weekOf: '2026-02-16', members: {
    'Owen Shaw': { hours: 17.19, orders: 55 },
    'Emma Swenson': { hours: 6.43, orders: 14 },
    'Warner Neuenschwander': { hours: 3.86, orders: 23 },
    'Izabella DePrima': { hours: 38.67, orders: 26 }
  } },
  { weekOf: '2026-02-23', members: {
    'Owen Shaw': { hours: 9.04, orders: 29 },
    'Emma Swenson': { hours: 10.73, orders: 35 },
    'Warner Neuenschwander': { hours: 2.21, orders: 7 },
    'Izabella DePrima': { hours: 39.99, orders: 18 }
  } },
  { weekOf: '2026-03-02', members: {
    'Owen Shaw': { hours: 20.24, orders: 90 },
    'Emma Swenson': { hours: 4.4, orders: 10 },
    'Warner Neuenschwander': { hours: 3.48, orders: 7 },
    'Izabella DePrima': { hours: 39.83, orders: 10 }
  } },
  { weekOf: '2026-03-09', members: {
    'Owen Shaw': { hours: 12.22, orders: 35 },
    'Emma Swenson': { hours: 7.02, orders: 18 },
    'Warner Neuenschwander': { hours: 0, orders: 0 },
    'Izabella DePrima': { hours: 28.76, orders: 3 }
  } },
  { weekOf: '2026-03-16', members: {
    'Owen Shaw': { hours: 23.19, orders: 67 },
    'Emma Swenson': { hours: 2.44, orders: 10 },
    'Warner Neuenschwander': { hours: 0, orders: 0 },
    'Izabella DePrima': { hours: 36.95, orders: 6 }
  } },
  { weekOf: '2026-03-23', members: {
    'Owen Shaw': { hours: 16.06, orders: 30 },
    'Emma Swenson': { hours: 6.25, orders: 26 },
    'Warner Neuenschwander': { hours: 0, orders: 0 },
    'Izabella DePrima': { hours: 37.66, orders: 14 }
  } },
  { weekOf: '2026-03-30', members: {
    'Owen Shaw': { hours: 26.25, orders: 78 },
    'Emma Swenson': { hours: 2.04, orders: 0 },
    'Warner Neuenschwander': { hours: 0, orders: 0 },
    'Izabella DePrima': { hours: 31.54, orders: 22 }
  } },
],
  design: [
  { weekOf: '2025-12-29', members: {
    'Chloe Leonard': { hours: 0, orders: 0 },
    'Kathryn Hill': { hours: 8.15, orders: 6 },
    'Sloane James': { hours: 0, orders: 0 },
    'Mia Legas': { hours: 2.91, orders: 3 },
    'Sarah Glissmeyer': { hours: 4.79, orders: 3 },
    'Jennika Merrill': { hours: 0, orders: 0 },
    'Audrey Brown': { hours: 0, orders: 0 },
    'Deanna L Brown': { hours: 15.2, orders: 9 }
  } },
  { weekOf: '2026-01-05', members: {
    'Chloe Leonard': { hours: 0, orders: 0 },
    'Kathryn Hill': { hours: 22.5, orders: 14 },
    'Sloane James': { hours: 6.22, orders: 0 },
    'Mia Legas': { hours: 13.75, orders: 9 },
    'Sarah Glissmeyer': { hours: 14.82, orders: 4 },
    'Jennika Merrill': { hours: 0, orders: 3 },
    'Audrey Brown': { hours: 0, orders: 0 },
    'Deanna L Brown': { hours: 18.94, orders: 10 }
  } },
  { weekOf: '2026-01-12', members: {
    'Chloe Leonard': { hours: 0, orders: 0 },
    'Kathryn Hill': { hours: 21.73, orders: 15 },
    'Sloane James': { hours: 0, orders: 0 },
    'Mia Legas': { hours: 16.2, orders: 11 },
    'Sarah Glissmeyer': { hours: 13.95, orders: 0 },
    'Jennika Merrill': { hours: 0, orders: 3 },
    'Audrey Brown': { hours: 0, orders: 0 },
    'Deanna L Brown': { hours: 26.29, orders: 12 }
  } },
  { weekOf: '2026-01-19', members: {
    'Chloe Leonard': { hours: 0, orders: 0 },
    'Kathryn Hill': { hours: 21.86, orders: 14 },
    'Sloane James': { hours: 0, orders: 0 },
    'Mia Legas': { hours: 7.77, orders: 3 },
    'Sarah Glissmeyer': { hours: 18.43, orders: 7 },
    'Jennika Merrill': { hours: 0, orders: 2 },
    'Audrey Brown': { hours: 1.33, orders: 0 },
    'Deanna L Brown': { hours: 27.85, orders: 19 }
  } },
  { weekOf: '2026-01-26', members: {
    'Chloe Leonard': { hours: 0, orders: 0 },
    'Kathryn Hill': { hours: 0, orders: 0 },
    'Sloane James': { hours: 21.53, orders: 15 },
    'Mia Legas': { hours: 11.26, orders: 15 },
    'Sarah Glissmeyer': { hours: 18.11, orders: 5 },
    'Jennika Merrill': { hours: 0, orders: 22 },
    'Audrey Brown': { hours: 13.64, orders: 10 },
    'Deanna L Brown': { hours: 24.37, orders: 18 }
  } },
  { weekOf: '2026-02-02', members: {
    'Chloe Leonard': { hours: 0, orders: 0 },
    'Kathryn Hill': { hours: 24.1, orders: 23 },
    'Sloane James': { hours: 0, orders: 0 },
    'Mia Legas': { hours: 18.38, orders: 26 },
    'Sarah Glissmeyer': { hours: 16.66, orders: 9 },
    'Jennika Merrill': { hours: 0, orders: 20 },
    'Audrey Brown': { hours: 11.51, orders: 10 },
    'Deanna L Brown': { hours: 21.31, orders: 12 }
  } },
  { weekOf: '2026-02-09', members: {
    'Chloe Leonard': { hours: 0, orders: 0 },
    'Kathryn Hill': { hours: 23.33, orders: 15 },
    'Sloane James': { hours: 19.53, orders: 14 },
    'Mia Legas': { hours: 11.07, orders: 14 },
    'Sarah Glissmeyer': { hours: 16.11, orders: 8 },
    'Jennika Merrill': { hours: 0, orders: 12 },
    'Audrey Brown': { hours: 9.32, orders: 3 },
    'Deanna L Brown': { hours: 28.02, orders: 18 }
  } },
  { weekOf: '2026-02-16', members: {
    'Chloe Leonard': { hours: 5.12, orders: 11 },
    'Kathryn Hill': { hours: 19.92, orders: 15 },
    'Sloane James': { hours: 14.91, orders: 11 },
    'Mia Legas': { hours: 20.22, orders: 27 },
    'Sarah Glissmeyer': { hours: 9.86, orders: 0 },
    'Jennika Merrill': { hours: 0, orders: 5 },
    'Audrey Brown': { hours: 5.76, orders: 3 },
    'Deanna L Brown': { hours: 27.3, orders: 25 }
  } },
  { weekOf: '2026-02-23', members: {
    'Chloe Leonard': { hours: 8.17, orders: 4 },
    'Kathryn Hill': { hours: 9.01, orders: 11 },
    'Sloane James': { hours: 23.01, orders: 22 },
    'Mia Legas': { hours: 6.27, orders: 6 },
    'Sarah Glissmeyer': { hours: 0, orders: 0 },
    'Jennika Merrill': { hours: 0, orders: 10 },
    'Audrey Brown': { hours: 9.06, orders: 12 },
    'Deanna L Brown': { hours: 27.3, orders: 26 }
  } },
  { weekOf: '2026-03-02', members: {
    'Chloe Leonard': { hours: 7.6, orders: 9 },
    'Kathryn Hill': { hours: 13.87, orders: 7 },
    'Sloane James': { hours: 16.57, orders: 16 },
    'Mia Legas': { hours: 0, orders: 0 },
    'Sarah Glissmeyer': { hours: 9.41, orders: 6 },
    'Jennika Merrill': { hours: 0, orders: 14 },
    'Audrey Brown': { hours: 9.62, orders: 7 },
    'Deanna L Brown': { hours: 19.78, orders: 17 }
  } },
  { weekOf: '2026-03-09', members: {
    'Chloe Leonard': { hours: 0, orders: 0 },
    'Kathryn Hill': { hours: 26.81, orders: 15 },
    'Sloane James': { hours: 20.75, orders: 26 },
    'Mia Legas': { hours: 10.86, orders: 18 },
    'Sarah Glissmeyer': { hours: 15.46, orders: 8 },
    'Jennika Merrill': { hours: 0, orders: 10 },
    'Audrey Brown': { hours: 0, orders: 0 },
    'Deanna L Brown': { hours: 20.25, orders: 19 }
  } },
  { weekOf: '2026-03-16', members: {
    'Chloe Leonard': { hours: 0, orders: 0 },
    'Kathryn Hill': { hours: 4.72, orders: 11 },
    'Sloane James': { hours: 19.85, orders: 20 },
    'Mia Legas': { hours: 18.55, orders: 13 },
    'Sarah Glissmeyer': { hours: 14.76, orders: 9 },
    'Jennika Merrill': { hours: 0, orders: 18 },
    'Audrey Brown': { hours: 8.14, orders: 8 },
    'Deanna L Brown': { hours: 24.64, orders: 21 }
  } },
  { weekOf: '2026-03-23', members: {
    'Chloe Leonard': { hours: 3.9, orders: 4 },
    'Kathryn Hill': { hours: 20.11, orders: 14 },
    'Sloane James': { hours: 19.28, orders: 19 },
    'Mia Legas': { hours: 16.03, orders: 21 },
    'Sarah Glissmeyer': { hours: 16.16, orders: 8 },
    'Jennika Merrill': { hours: 0, orders: 11 },
    'Audrey Brown': { hours: 8.92, orders: 8 },
    'Deanna L Brown': { hours: 23.49, orders: 23 }
  } },
  { weekOf: '2026-03-30', members: {
    'Chloe Leonard': { hours: 4.06, orders: 9 },
    'Kathryn Hill': { hours: 20.19, orders: 12 },
    'Sloane James': { hours: 20.18, orders: 24 },
    'Mia Legas': { hours: 18.56, orders: 18 },
    'Sarah Glissmeyer': { hours: 17.18, orders: 8 },
    'Jennika Merrill': { hours: 0, orders: 15 },
    'Audrey Brown': { hours: 7.39, orders: 8 },
    'Deanna L Brown': { hours: 19.06, orders: 18 }
  } },
],
  preservation: [
  { weekOf: '2025-12-29', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 20.22, orders: 24 }
  } },
  { weekOf: '2026-01-05', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 29.68, orders: 20 }
  } },
  { weekOf: '2026-01-12', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 21.16, orders: 16 }
  } },
  { weekOf: '2026-01-19', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 13.52, orders: 21 }
  } },
  { weekOf: '2026-01-26', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 9.1, orders: 12 }
  } },
  { weekOf: '2026-02-02', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 8.44, orders: 10 }
  } },
  { weekOf: '2026-02-09', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 15.15, orders: 25 }
  } },
  { weekOf: '2026-02-16', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 15.55, orders: 27 }
  } },
  { weekOf: '2026-02-23', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 15.88, orders: 24 }
  } },
  { weekOf: '2026-03-02', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 10.88, orders: 11 }
  } },
  { weekOf: '2026-03-09', members: {
    'Emma Dunakey': { hours: 10.69, orders: 19 },
    'Katelyn Wilson': { hours: 0, orders: 0 }
  } },
  { weekOf: '2026-03-16', members: {
    'Emma Dunakey': { hours: 0, orders: 0 },
    'Katelyn Wilson': { hours: 25.37, orders: 46 }
  } },
  { weekOf: '2026-03-23', members: {
    'Emma Dunakey': { hours: 1.14, orders: 5 },
    'Katelyn Wilson': { hours: 21.87, orders: 33 }
  } },
  { weekOf: '2026-03-30', members: {
    'Emma Dunakey': { hours: 7.75, orders: 15 },
    'Katelyn Wilson': { hours: 17.33, orders: 22 }
  } },
],
};

// ─── CSV historical data — Utah (pre-loaded from spreadsheet) ────────────────
const UTAH_HISTORICALS: Record<string, Record<string, { hours: number; orders: number }>> = {
  fulfillment: {
    'Izabella DePrima':      { hours: 2.59+40.06+33.20+39.95+28.11+6.53+39.60+38.67+39.99+39.83+28.76+36.95+37.66+31.54, orders: 10+8+21+12+22+26+18+10+3+6+14+22 },
    'Warner Neuenschwander': { hours: 3.73+5.73+1.12+2.07+7.17+7.21+3.86+2.21+3.48, orders: 16+18+8+5+13+9+23+7+7 },
    'Owen Shaw':             { hours: 6.25+10.41+19.80+14.12+13.85+7.41+22.71+17.19+9.04+20.24+12.22+23.19+16.06+26.25, orders: 15+23+44+40+31+21+55+55+29+90+35+67+30+78 },
    'Emma Swenson':          { hours: 9.77+6.67+12.09+6.10+6.86+4.65+6.43+10.73+4.40+7.02+2.44+6.25+2.04, orders: 21+25+31+17+15+9+14+35+10+18+10+26 },
  },
  design: {
    'Deanna L Brown':   { hours: 15.20+18.94+26.29+27.85+24.37+21.31+28.02+27.30+27.30+19.78+20.25+24.64+23.49+19.06, orders: 9+10+12+19+18+12+18+25+26+17+19+21+23+18 },
    'Sarah Glissmeyer': { hours: 4.79+14.82+13.95+18.43+18.11+16.66+16.11+9.86+9.41+15.46+14.76+16.16+17.18, orders: 3+4+0+7+5+9+8+6+8+9+8+8 },
    'Kathryn Hill':     { hours: 8.15+22.50+21.73+21.86+24.10+23.33+19.92+9.01+13.87+26.81+4.72+20.11+20.19, orders: 6+14+15+14+23+15+15+11+7+15+11+14+12 },
    'Mia Legas':        { hours: 2.91+13.75+16.20+7.77+11.26+18.38+11.07+20.22+6.27+10.86+18.55+16.03+18.56, orders: 3+9+11+3+15+26+14+27+6+18+13+21+18 },
    'Sloane James':     { hours: 6.22+21.53+19.53+14.91+23.01+16.57+20.75+19.85+19.28+20.18, orders: 15+14+11+22+16+26+20+19+24 },
    'Audrey Brown':     { hours: 1.33+13.64+11.51+9.32+5.76+9.06+9.62+8.14+8.92+7.39, orders: 10+10+3+3+12+7+8+8+8 },
    'Chloe Leonard':    { hours: 5.12+8.17+7.60+3.90+4.06, orders: 11+4+9+4+9 },
    'Jennika Merrill':  { hours: 0, orders: 3+3+2+22+20+12+5+10+14+10+18+11+15 },
  },
  preservation: {
    'Katelyn Wilson':  { hours: 20.22+29.68+21.16+13.52+9.10+8.44+15.15+15.55+15.88+10.88+25.37+21.87+17.33, orders: 24+20+16+21+12+10+25+27+24+11+46+33+22 },
    'Emma Dunakey':    { hours: 10.69+1.14+7.75, orders: 19+5+15 },
  },
};

// ─── DeptHistoricalsTab ────────────────────────────────────────────────────────
function DeptHistoricalsTab({ department, location, teamMembers, teamActuals, onActualsSaved, showReceivedField, ordersLabel, onPresActualsSaved }: {
  department:          'preservation' | 'fulfillment' | 'design';
  location:            'Utah' | 'Georgia';
  teamMembers:         string[];
  teamActuals:         { department: string; week_of: string; member_name: string; actual_hours: number; actual_orders: number; hours_source?: string }[];
  onActualsSaved:      () => void;
  showReceivedField:   boolean;
  ordersLabel:         string;
  onPresActualsSaved?: (weekOf: string, received: number) => void;
}) {
  const HIST_WEEKS  = 20;
  const weekOptions = pastWeeks(HIST_WEEKS);
  const [saving,    setSaving]  = useState(false);
  const [saveMsg,   setSaveMsg] = useState('');
  const [localEdits, setLocalEdits] = useState<Record<string, Record<string, { hours: number; orders: number }>>>({});
  const [totalReceived, setTotalReceived] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seeded = useRef(false);

  // YTD totals from CSV for Utah — shown as reference
  const ytdData = location === 'Utah' ? (UTAH_HISTORICALS[department] ?? {}) : {};

  // Seed per-week CSV data into Supabase on first load if no actuals exist yet
  useEffect(() => {
    if (seeded.current || location !== 'Utah') return;
    const existing = teamActuals.filter(r => r.department === department);
    if (existing.length > 0) { seeded.current = true; return; }
    const weeklyData = UTAH_HISTORICALS_BY_WEEK[department];
    if (!weeklyData || weeklyData.length === 0) return;
    seeded.current = true;
    const posts: Promise<unknown>[] = [];
    weeklyData.forEach(({ weekOf, members }) => {
      Object.entries(members).forEach(([name, d]) => {
        if (d.hours === 0 && d.orders === 0) return;
        posts.push(fetch('/api/actuals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'team', location, weekOf, department, memberName: name, actualHours: d.hours, actualOrders: d.orders }),
        }));
      });
    });
    Promise.all(posts).then(() => onActualsSaved()).catch(() => {});
  }, [teamActuals, department, location]); // eslint-disable-line react-hooks/exhaustive-deps

  function getEntry(weekOf: string, name: string) {
    if (localEdits[weekOf]?.[name]) return { ...localEdits[weekOf][name], source: 'manual' };
    const row = teamActuals.find(r => r.department === department && r.week_of === weekOf && r.member_name === name);
    return { hours: row?.actual_hours ?? 0, orders: row?.actual_orders ?? 0, source: row?.hours_source ?? 'manual' };
  }

  function setEntry(weekOf: string, name: string, field: 'hours' | 'orders', val: number) {
    setLocalEdits(prev => ({
      ...prev,
      [weekOf]: { ...(prev[weekOf] ?? {}), [name]: { ...getEntry(weekOf, name), [field]: val } },
    }));
    // Auto-save with debounce
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        const entry = { ...getEntry(weekOf, name), [field]: val };
        await fetch('/api/actuals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'team', location, weekOf, department, memberName: name, actualHours: entry.hours, actualOrders: entry.orders }),
        });
        setSaveMsg('✓');
        onActualsSaved();
        setTimeout(() => setSaveMsg(''), 1500);
      } catch { setSaveMsg('Save failed'); }
      setSaving(false);
    }, 800);
  }

  // Weeks with any data (from Supabase or local edits)
  const weeksWithData = new Set([
    ...teamActuals.filter(r => r.department === department).map(r => r.week_of),
    ...Object.keys(localEdits),
  ]);

  // All weeks to show: past 20 weeks, sorted newest first
  const displayWeeks = [...weekOptions].reverse(); // oldest left, newest right — scroll right for recent


  // YTD totals computed from Supabase actuals + CSV seed data
  const ytdTotals = useMemo(() => {
    const map: Record<string, { hours: number; orders: number }> = {};
    teamActuals.filter(r => r.department === department).forEach(r => {
      if (!map[r.member_name]) map[r.member_name] = { hours: 0, orders: 0 };
      map[r.member_name].hours  += r.actual_hours;
      map[r.member_name].orders += r.actual_orders;
    });
    Object.entries(ytdData).forEach(([name, d]) => {
      if (!map[name]) map[name] = { hours: 0, orders: 0 };
      if (map[name].orders === 0) { map[name].hours = d.hours; map[name].orders = d.orders; }
    });
    return map;
  }, [teamActuals, department, ytdData]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Historicals — {department} · {location}</h3>
          <p className="text-xs text-slate-400 mt-0.5">Edit any cell — saves automatically. Shows last {displayWeeks.length} weeks.</p>
        </div>
        <div className="flex items-center gap-2">
          {saving && <span className="text-xs text-slate-400 italic">Saving…</span>}
          {saveMsg && <span className="text-xs text-green-600">{saveMsg}</span>}
        </div>
      </div>

      {/* YTD summary */}
      {Object.keys(ytdTotals).length > 0 && (
        <div className="bg-white border border-slate-100 rounded-xl p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">Year-to-date totals</p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="px-3 py-1.5 text-left font-medium text-slate-400">Team member</th>
                  <th className="px-3 py-1.5 text-center font-medium text-slate-400">Total {ordersLabel}</th>
                  <th className="px-3 py-1.5 text-center font-medium text-slate-400">Total hours</th>
                  <th className="px-3 py-1.5 text-center font-medium text-slate-400">YTD ratio</th>
                </tr>
              </thead>
              <tbody>
                {teamMembers.map((name, i) => {
                  const d = ytdTotals[name];
                  if (!d || (d.hours === 0 && d.orders === 0)) return null;
                  const ratio = d.hours > 0 && d.orders > 0 ? d.hours / d.orders : null;
                  return (
                    <tr key={name} className={i % 2 === 0 ? '' : 'bg-slate-50/40'}>
                      <td className="px-3 py-1.5 font-medium text-slate-700">{name}</td>
                      <td className="px-3 py-1.5 text-center text-indigo-700 font-semibold">{Math.round(d.orders)}</td>
                      <td className="px-3 py-1.5 text-center text-slate-500">{Math.round(d.hours)}h</td>
                      <td className="px-3 py-1.5 text-center">
                        {ratio !== null ? (
                          <span className={`font-semibold ${ratio <= 0.7 ? 'text-green-700' : ratio <= 1.5 ? 'text-amber-700' : 'text-red-700'}`}>
                            {ratio.toFixed(2)} h/ord
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* All weeks inline-editable grid */}
      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700">All weeks overview</h3>
          <p className="text-xs text-slate-400 mt-0.5">Click any number to edit. Top = {ordersLabel}, bottom = hours. Saves automatically.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap min-w-[140px]">Team member</th>
                {displayWeeks.map(w => (
                  <th key={w} className="px-2 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[80px]">
                    {fmtDate(w).split(',')[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {teamMembers.map((name, ni) => (
                <tr key={name} className={ni % 2 === 0 ? '' : 'bg-slate-50/40'}>
                  <td className="sticky left-0 bg-inherit px-4 py-2 font-medium text-slate-700 whitespace-nowrap">{name}</td>
                  {displayWeeks.map(w => {
                    const entry = getEntry(w, name);
                    const ratio = entry.hours > 0 && entry.orders > 0 ? entry.hours / entry.orders : null;
                    const hasData = entry.hours > 0 || entry.orders > 0;
                    return (
                      <td key={w} className={`px-1 py-1 text-center ${hasData ? '' : 'opacity-30'}`}>
                        <div className="flex flex-col gap-0.5 items-center">
                          <input type="number" min="0" value={entry.orders || ''}
                            placeholder="0" title="Orders"
                            onChange={e => setEntry(w, name, 'orders', parseInt(e.target.value) || 0)}
                            className="w-12 border border-slate-200 rounded px-1 py-0.5 text-center text-indigo-700 font-medium bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                          <input type="number" min="0" step="0.5" value={entry.hours || ''}
                            placeholder="0h" title="Hours"
                            onChange={e => setEntry(w, name, 'hours', parseFloat(e.target.value) || 0)}
                            className={`w-12 border border-slate-200 rounded px-1 py-0.5 text-center bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 ${entry.source === 'upload' ? 'text-green-600 font-medium' : 'text-slate-400'}`} />
                          {ratio !== null && (
                            <span className={`text-[9px] font-medium ${ratio <= 0.7 ? 'text-green-700' : ratio <= 1.5 ? 'text-amber-700' : 'text-red-600'}`}>
                              {ratio.toFixed(2)}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {/* Flex workers — people with hours in this dept not on the roster */}
              {(() => {
                const rosterNames = new Set(teamMembers);
                const flexNames = [...new Set(
                  teamActuals
                    .filter(r => r.department === department && r.actual_hours > 0 && !rosterNames.has(r.member_name))
                    .map(r => r.member_name)
                )];
                if (flexNames.length === 0) return null;
                return flexNames.map((name, ni) => (
                  <tr key={name} className={`border-t border-dashed border-slate-200 ${ni % 2 === 0 ? 'bg-slate-50/20' : 'bg-slate-50/40'}`}>
                    <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap">
                      <div className="font-medium text-slate-600">{name}</div>
                      <div className="text-[10px] text-indigo-400">flex</div>
                    </td>
                    {displayWeeks.map(w => {
                      const entry = getEntry(w, name);
                      const hasData = entry.hours > 0 || entry.orders > 0;
                      return (
                        <td key={w} className={`px-1 py-1 text-center ${hasData ? '' : 'opacity-30'}`}>
                          <div className="flex flex-col gap-0.5 items-center">
                            <span className="text-indigo-700 font-medium text-xs">{entry.orders > 0 ? entry.orders : ''}</span>
                            {entry.hours > 0 && (
                              <span className={`text-xs font-medium ${entry.source === 'upload' ? 'text-green-600' : 'text-slate-400'}`}>
                                {entry.hours.toFixed(1)}h
                              </span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── PreservationSection ───────────────────────────────────────────────────────

// ─── useDraggableOrder ────────────────────────────────────────────────────────
function useDraggableOrder<T extends { id: string }>(
  items: T[],
  onReorder: (newOrder: string[]) => void
) {
  const dragId = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  function handleDragStart(id: string) { dragId.current = id; }
  function handleDragOver(e: React.DragEvent, id: string) { e.preventDefault(); setDragOverId(id); }
  function handleDrop(targetId: string) {
    if (!dragId.current || dragId.current === targetId) { setDragOverId(null); return; }
    const ids = items.map(i => i.id);
    const fromIdx = ids.indexOf(dragId.current);
    const toIdx   = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) { setDragOverId(null); return; }
    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragId.current);
    dragId.current = null;
    setDragOverId(null);
    onReorder(next);
  }
  function handleDragEnd() { dragId.current = null; setDragOverId(null); }
  return { dragOverId, handleDragStart, handleDragOver, handleDrop, handleDragEnd };
}

// ─── PresRosterEditor ─────────────────────────────────────────────────────────
function PresRosterEditor({ team, presRoster, onUpdateRoster, onRemove, onReorder, onRefreshRatio, deptLocation, employeeRates = {}, onTemplateChange, onResetToTemplate }: {
  team: (Omit<PresTeamMember, 'hours'> & { hours: unknown })[];
  presRoster: Record<string, { ratio: number; rate: number; name: string; payType?: 'hourly'|'salary'; annualSalary?: number; role?: string; _removed?: boolean; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }>;
  onUpdateRoster: (id: string, field: 'ratio' | 'rate' | 'name' | 'payType' | 'annualSalary' | 'role' | 'excludeFromCost' | 'startDate' | 'endDate', val: string | number | boolean) => void;
  onRemove: (id: string) => void;
  onReorder: (newOrder: string[]) => void;
  onRefreshRatio: (id: string, name: string) => void;
  deptLocation?: string;
  employeeRates?: Record<string, { hourlyRate: number }>;
  onTemplateChange: (id: string, dayIdx: number, value: number) => void;
  onResetToTemplate?: (id: string) => void;
}) {
  const { dragOverId, handleDragStart, handleDragOver, handleDrop, handleDragEnd } =
    useDraggableOrder(team, onReorder);
  return (
    <div>
      <div className="grid grid-cols-[16px_1fr_80px_90px_20px] gap-2 mb-2 px-1 text-xs font-medium text-slate-400">
        <span /><span>Name</span><span className="text-center">Role</span><span className="text-center">Ratio</span><span />
      </div>
      <div className="space-y-2">
        {team.map((m) => {
          const inRippling = !!(employeeRates[m.name] || employeeRates[m.name?.toLowerCase()]);
          return (
          <div key={m.id} className="space-y-1">
            <div
              className={`grid grid-cols-[16px_1fr_80px_90px_20px] gap-2 items-center rounded transition-colors ${dragOverId === m.id ? 'bg-indigo-50' : ''}`}
              onDragOver={e => handleDragOver(e, m.id)}
              onDrop={() => handleDrop(m.id)}>
              <span
                draggable
                onDragStart={e => { e.stopPropagation(); handleDragStart(m.id); }}
                onDragEnd={handleDragEnd}
                className="text-slate-300 cursor-grab active:cursor-grabbing text-center select-none px-1">⠿</span>
              <div className="flex items-center gap-1.5 min-w-0">
                <div className="flex-1 min-w-0">
                  <EmployeeAutocomplete
                    value={m.name}
                    location={deptLocation ?? 'Utah'}
                    department="Preservation"
                    onChange={val => onUpdateRoster(m.id, 'name', val)}
                    onSelect={(emp: RipplingEmployee) => { onUpdateRoster(m.id, 'name', emp.full_name); onUpdateRoster(m.id, 'role', emp.role); onUpdateRoster(m.id, 'rate', emp.hourly_rate ?? 0); onUpdateRoster(m.id, 'payType', emp.pay_type); onUpdateRoster(m.id, 'annualSalary', emp.annual_salary ?? 0); }}
                  />
                </div>
                {m.isManager && (
                  <span className="shrink-0 text-[9px] font-medium text-violet-600 bg-violet-50 border border-violet-200 rounded px-1.5 py-0.5">Manager</span>
                )}
              </div>
              <select value={m.role ?? 'specialist'} onChange={e => onUpdateRoster(m.id, 'role', e.target.value)}
                className="border border-slate-200 rounded px-1.5 py-1.5 text-xs text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300">
                <option value="specialist">Specialist</option>
                <option value="senior">Senior</option>
                <option value="master">Master</option>
              </select>
              <div className="flex items-center gap-1">
                <input type="number" value={m.ratio} step="0.05" min="0.05"
                  onChange={e => onUpdateRoster(m.id, 'ratio', parseFloat(e.target.value) || 0)}
                  className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                <button onClick={() => onRefreshRatio(m.id, m.name)} title="Update from last 4 weeks"
                  className="text-slate-300 hover:text-indigo-500 transition-colors text-sm shrink-0">↻</button>
              </div>
              <button onClick={() => onRemove(m.id)}
                className="text-slate-300 hover:text-red-400 transition-colors text-xl leading-none text-center">×</button>
            </div>
            {!inRippling && m.name && m.name.length > 1 && (
              <div className="ml-6 flex items-center gap-2">
                <span className="text-[10px] text-amber-600">Not in Rippling — set hourly rate:</span>
                <input type="number" value={m.rate || ''} step="0.01" min="0" placeholder="$/hr"
                  onChange={e => onUpdateRoster(m.id, 'rate', parseFloat(e.target.value) || 0)}
                  className="w-20 border border-amber-200 rounded px-2 py-1 text-xs text-center text-slate-700 bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-300" />
              </div>
            )}
            <div className="ml-6 flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[10px] text-slate-500 cursor-pointer">
                <input type="checkbox" checked={!!(presRoster[m.id] as {excludeFromCost?: boolean})?.excludeFromCost}
                  onChange={e => onUpdateRoster(m.id, 'excludeFromCost', e.target.checked)}
                  className="rounded" />
                Exclude from CPO cost (flex from another dept)
              </label>
            </div>
            <div className="ml-6 flex items-center gap-1.5">
              <span className="text-[10px] text-slate-400 w-32 shrink-0">
                Standard schedule{!presRoster[m.id]?.standardWeeklyHours && <span className="text-amber-500"> — not set</span>}
              </span>
              {WEEKDAY_LABELS.map((label, di) => (
                <label key={di} className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-slate-300">{label[0]}</span>
                  <input type="number" min="0" step="0.5" placeholder="0"
                    value={presRoster[m.id]?.standardWeeklyHours?.[di] || ''}
                    onChange={e => onTemplateChange(m.id, di, parseFloat(e.target.value) || 0)}
                    title={`${label} standard hours`}
                    className="w-10 border border-slate-200 rounded px-1 py-0.5 text-center text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                </label>
              ))}
              {onResetToTemplate && (
                <button onClick={() => onResetToTemplate(m.id)}
                  title="Clear scheduled hours from this week forward and go back to following this template"
                  className="text-[10px] text-slate-400 hover:text-indigo-600 whitespace-nowrap ml-1">
                  ↺ Reset to template
                </button>
              )}
            </div>
            <div className="ml-6 flex items-center gap-1.5">
              <span className="text-[10px] text-slate-400 w-32 shrink-0">Employment dates</span>
              <EmploymentDatesEditor
                startDate={presRoster[m.id]?.startDate}
                endDate={presRoster[m.id]?.endDate}
                onStartDateChange={val => onUpdateRoster(m.id, 'startDate', val)}
                onEndDateChange={val => onUpdateRoster(m.id, 'endDate', val)}
              />
            </div>
          </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-slate-400">Pay rates &amp; titles come from Rippling upload. Members not in Rippling can have rates set manually.</p>
    </div>
  );
}

// ─── FfRosterEditor ────────────────────────────────────────────────────────────
function FfRosterEditor({ team, ffRoster, onUpdateName, onUpdateRoster, onRemove, onReorder, onRefreshRatio, deptLocation, onTemplateChange, onResetToTemplate }: {
  team: (Omit<FfTeamMember, 'hours'> & { hours: unknown })[];
  ffRoster: Record<string, { ratio: number; rate: number; name: string; payType?: 'hourly'|'salary'; annualSalary?: number; _removed?: boolean; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }>;
  employeeRates?:       Record<string, { hourlyRate: number; annualSalary: number; payType: 'hourly'|'salary' }>;
  onUpdateName: (id: string, name: string) => void;
  onUpdateRoster: (mi: number, field: 'ratio' | 'rate' | 'payType' | 'annualSalary' | 'role' | 'startDate' | 'endDate', val: number | string) => void;
  onRemove: (id: string) => void;
  onReorder: (newOrder: string[]) => void;
  onRefreshRatio: (id: string, name: string) => void;
  deptLocation?: string;
  onTemplateChange: (id: string, dayIdx: number, value: number) => void;
  onResetToTemplate?: (id: string) => void;
}) {
  const { dragOverId, handleDragStart, handleDragOver, handleDrop, handleDragEnd } =
    useDraggableOrder(team, onReorder);
  return (
    <div>
      <div className="grid grid-cols-[16px_1fr_80px_90px_20px] gap-2 mb-2 px-1 text-xs font-medium text-slate-400">
        <span /><span>Name</span><span className="text-center">Role</span><span className="text-center">Ratio</span><span />
      </div>
      <div className="space-y-3">
        {team.map((m, mi) => {
          const template = ffRoster[m.id]?.standardWeeklyHours;
          return (
          <div key={m.id}
            className={`rounded transition-colors ${dragOverId === m.id ? 'bg-indigo-50' : ''}`}
            onDragOver={e => handleDragOver(e, m.id)}
            onDrop={() => handleDrop(m.id)}>
            <div className="grid grid-cols-[16px_1fr_80px_90px_20px] gap-2 items-center">
              <span
                draggable
                onDragStart={e => { e.stopPropagation(); handleDragStart(m.id); }}
                onDragEnd={handleDragEnd}
                className="text-slate-300 cursor-grab active:cursor-grabbing text-center select-none px-1">⠿</span>
              <div className="flex items-center gap-1.5 min-w-0">
                <div className="flex-1 min-w-0">
                  <EmployeeAutocomplete
                    value={m.name}
                    location={deptLocation ?? 'Utah'}
                    department="Fulfillment"
                    onChange={val => onUpdateName(m.id, val)}
                    onSelect={(emp: RipplingEmployee) => { onUpdateName(m.id, emp.full_name); onUpdateRoster(mi, 'role', emp.role); onUpdateRoster(mi, 'rate', emp.hourly_rate ?? 0); onUpdateRoster(mi, 'payType', emp.pay_type); onUpdateRoster(mi, 'annualSalary', emp.annual_salary ?? 0); }}
                  />
                </div>
                {m.isManager && (
                  <span className="shrink-0 text-[9px] font-medium text-violet-600 bg-violet-50 border border-violet-200 rounded px-1.5 py-0.5">Manager</span>
                )}
              </div>
              <select value={m.role ?? 'specialist'} onChange={e => onUpdateRoster(mi, 'role', e.target.value)}
                className="border border-slate-200 rounded px-1.5 py-1.5 text-xs text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300">
                <option value="specialist">Specialist</option>
                <option value="senior">Senior</option>
                <option value="master">Master</option>
              </select>
              <div className="flex items-center gap-1">
                <input type="number" value={m.ratio} step="0.05" min="0.05"
                  onChange={e => onUpdateRoster(mi, 'ratio', parseFloat(e.target.value) || 0)}
                  className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                <button onClick={() => onRefreshRatio(m.id, m.name)} title="Update from last 4 weeks"
                  className="text-slate-300 hover:text-indigo-500 transition-colors text-sm shrink-0">↻</button>
              </div>
              <button onClick={() => onRemove(m.id)}
                className="text-slate-300 hover:text-red-400 transition-colors text-xl leading-none text-center">×</button>
            </div>
            <div className="flex items-center gap-1.5 pl-6 mt-1.5">
              <span className="text-[10px] text-slate-400 w-32 shrink-0">
                Standard schedule{!template && <span className="text-amber-500"> — not set</span>}
              </span>
              {WEEKDAY_LABELS.map((label, di) => (
                <label key={di} className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-slate-300">{label[0]}</span>
                  <input type="number" min="0" step="0.5" placeholder="0"
                    value={template?.[di] || ''}
                    onChange={e => onTemplateChange(m.id, di, parseFloat(e.target.value) || 0)}
                    title={`${label} standard hours`}
                    className="w-10 border border-slate-200 rounded px-1 py-0.5 text-center text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                </label>
              ))}
              {onResetToTemplate && (
                <button onClick={() => onResetToTemplate(m.id)}
                  title="Clear scheduled hours from this week forward and go back to following this template"
                  className="text-[10px] text-slate-400 hover:text-indigo-600 whitespace-nowrap ml-1">
                  ↺ Reset to template
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5 pl-6 mt-1.5">
              <span className="text-[10px] text-slate-400 w-32 shrink-0">Employment dates</span>
              <EmploymentDatesEditor
                startDate={ffRoster[m.id]?.startDate}
                endDate={ffRoster[m.id]?.endDate}
                onStartDateChange={val => onUpdateRoster(mi, 'startDate', val)}
                onEndDateChange={val => onUpdateRoster(mi, 'endDate', val)}
              />
            </div>
          </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-slate-400">Pay rates &amp; titles come from Rippling upload.</p>
    </div>
  );
}

function PreservationSection({ location, preservationQueue, countsLoading, teamActuals, onActualsSaved,
  presHours, presDailyHours, presCheckHours, onPresDailyHoursChange, onPresCheckHoursChange, presRoster, presSettings, mgrTotalHours, mgrTotalDailyHours, onPresHoursChange, onPresRosterChange, onPresSettingsChange, onMgrTotalHoursChange, onMgrTotalDailyHoursChange, employeeRates = {}, weeklyEstimates = {}, presActuals = {}, onReceivedSaved, canViewCPO = true, userRole = 'admin',
  bouquetsReceivedByWeek, presNewHireHours, onPresNewHireHoursChange }: {
  location:              'Utah' | 'Georgia';
  preservationQueue:     number;
  countsLoading:         boolean;
  teamActuals:           { department: string; week_of: string; member_name: string; actual_hours: number; actual_orders: number }[];
  onActualsSaved:        () => void;
  presHours:             Record<string, Record<string, number>>;
  presDailyHours:        DailyHoursMap;
  presCheckHours:        DailyHoursMap;
  onPresDailyHoursChange:(h: DailyHoursMap) => void;
  onPresCheckHoursChange:(h: DailyHoursMap) => void;
  presRoster:            Record<string, { ratio: number; rate: number; name: string; payType?: 'hourly'|'salary'; annualSalary?: number; _removed?: boolean; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }>;
  employeeRates?:         Record<string, { hourlyRate: number; annualSalary: number; payType: 'hourly'|'salary' }>;
  presSettings:          { dateFrom?: string; dateTo?: string; weekOverrides?: Record<string, { ut: number; ga: number }>; dayPcts?: number[]; dayOverrides?: Record<string, { ut: number; ga: number }>; dailyReceived?: Record<string, number>; checkSettings?: { c1Min?: number; c1Max?: number; c2Min?: number; c2Max?: number; c3Min?: number; c3Max?: number; c1Mins?: number; c2Mins?: number; c3Mins?: number } };
  mgrTotalHours:         Record<string, Record<string, number>>;
  mgrTotalDailyHours:    DailyHoursMap;
  onPresHoursChange:     (h: Record<string, Record<string, number>>) => void;
  onPresRosterChange:    (r: Record<string, { ratio: number; rate: number; name: string; payType?: 'hourly'|'salary'; annualSalary?: number; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }>) => void;
  onPresSettingsChange:  (s: { dateFrom?: string; dateTo?: string; weekOverrides?: Record<string, { ut: number; ga: number }>; dayPcts?: number[]; dayOverrides?: Record<string, { ut: number; ga: number }>; dailyReceived?: Record<string, number>; checkSettings?: { c1Min?: number; c1Max?: number; c2Min?: number; c2Max?: number; c3Min?: number; c3Max?: number; c1Mins?: number; c2Mins?: number; c3Mins?: number } }) => void;
  onMgrTotalHoursChange: (h: Record<string, Record<string, number>>) => void;
  onMgrTotalDailyHoursChange: (h: DailyHoursMap) => void;
  weeklyEstimates:       Record<string, { ut: number; ga: number }>;
  presActuals?:          Record<string, number>;
  onReceivedSaved?:      () => void;
  canViewCPO?:           boolean;
  userRole?:             string;
  // Same "Bouquets received" estimate stream shown on Design's Queue &
  // Turnaround tab (52 weeks) — Preservation's own turnaround uses this as
  // its arrivals, rather than a separately-edited estimate.
  bouquetsReceivedByWeek: number[];
  presNewHireHours:        Record<string, number>;
  onPresNewHireHoursChange:(h: Record<string, number>) => void;
}) {
  const today    = new Date();
  const monday   = new Date(today);
  monday.setDate(today.getDate() - (today.getDay() === 0 ? 6 : today.getDay() - 1));
  const mondayIso = monday.toISOString().split('T')[0];
  const sundayIso = addDays(mondayIso, 6);

  const [presTab,       setPresTab]      = useState<'schedule' | 'queue' | 'historicals'>('schedule');
  const [showRoster,    setShowRoster]   = useState(false);
  const [weekOffset,    setWeekOffset]   = useState(0);
  const [presInputMode, setPresInputMode] = useState<InputMode>('hours');
  const [activePresTab, setActivePresTab] = useState<'weekly' | '52week'>('weekly');
  const [presThisWeekOffset, setPresThisWeekOffset] = useState(0);
  const maxPresThisWeekOffset = WEEKS - 1;

  // Date range for the 7-day delivery estimates
  const dateFrom = presSettings.dateFrom ?? mondayIso;
  const dateTo   = presSettings.dateTo   ?? sundayIso;
  const weekOverrides = presSettings.weekOverrides ?? {};
  const dayPcts = presSettings.dayPcts ?? [20, 25, 25, 20, 10];
  const dayOverrides = presSettings.dayOverrides ?? {};
  const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

  // ── Check settings + daily received ──────────────────────────────────────
  const dailyReceived: Record<string, number> = presSettings.dailyReceived ?? {};
  const checkSettings = presSettings.checkSettings ?? {};
  const c1Min  = checkSettings.c1Min  ?? 2;
  const c1Max  = checkSettings.c1Max  ?? 3;
  const c2Min  = checkSettings.c2Min  ?? 5;
  const c2Max  = checkSettings.c2Max  ?? 6;
  const c3Min  = checkSettings.c3Min  ?? 8;
  const c3Max  = checkSettings.c3Max  ?? 9;
  const c1Mins = checkSettings.c1Mins ?? (location === 'Georgia' ? 10   : 3);
  const c2Mins = checkSettings.c2Mins ?? (location === 'Georgia' ? 5.5  : 2);
  const c3Mins = checkSettings.c3Mins ?? (location === 'Georgia' ? 3    : 1);
  const [showCheckSettings, setShowCheckSettings] = useState(false);

  function setDailyReceived(iso: string, val: number) {
    const next = { ...dailyReceived, [iso]: val };
    onPresSettingsChange({ ...presSettings, dailyReceived: next });
  }

  function setCheckSetting(field: string, val: number) {
    onPresSettingsChange({ ...presSettings, checkSettings: { ...checkSettings, [field]: val } });
  }

  // For a given day ISO, compute how many bouquets need each check type
  // based on prior dailyReceived entries
  // Snap a date to the nearest weekday: Saturday -> Friday, Sunday -> Monday
  function snapToWeekday(iso: string): string {
    const d = new Date(iso + 'T12:00:00');
    const dow = d.getDay();
    if (dow === 6) d.setDate(d.getDate() - 1); // Saturday -> Friday
    if (dow === 0) d.setDate(d.getDate() + 1); // Sunday -> Monday
    return d.toISOString().split('T')[0];
  }

  // For a source date, add N business days and return the resulting date ISO
  function addBizDays(srcIso: string, n: number): string {
    const d = new Date(srcIso + 'T12:00:00');
    let added = 0;
    while (added < n) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) added++;
    }
    return d.toISOString().split('T')[0];
  }

  // Build a map of dayIso -> { c1, c2, c3, sources } from all dailyReceived entries
  // Each check falls on: addBizDays(src, checkDay), snapped to nearest weekday
  // Memoised over dailyReceived + check settings
  function buildCheckMap(): Record<string, { c1: number; c2: number; c3: number; sources: Record<string, { c1src?: string; c2src?: string; c3src?: string; snapped: boolean }> }> {
    const map: Record<string, { c1: number; c2: number; c3: number; sources: Record<string, { c1src?: string; c2src?: string; c3src?: string; snapped: boolean }> }> = {};
    function add(dayIso: string, checkKey: 'c1'|'c2'|'c3', count: number, srcIso: string) {
      const snapped = snapToWeekday(dayIso) !== dayIso;
      const targetIso = snapToWeekday(dayIso);
      if (!map[targetIso]) map[targetIso] = { c1: 0, c2: 0, c3: 0, sources: {} };
      map[targetIso][checkKey] += count;
      if (!map[targetIso].sources[srcIso]) map[targetIso].sources[srcIso] = { snapped };
      map[targetIso].sources[srcIso][`${checkKey}src`] = srcIso;
      map[targetIso].sources[srcIso].snapped = snapped;
    }
    Object.entries(dailyReceived).forEach(([srcIso, count]) => {
      if (!count) return;
      // For each check, pick a day in the middle of the window
      // Use min day (earliest the check can happen)
      for (let day = c1Min; day <= c1Max; day++) add(addBizDays(srcIso, day), 'c1', count, srcIso);
      for (let day = c2Min; day <= c2Max; day++) add(addBizDays(srcIso, day), 'c2', count, srcIso);
      for (let day = c3Min; day <= c3Max; day++) add(addBizDays(srcIso, day), 'c3', count, srcIso);
    });
    // Dedupe: if same src appears multiple times for same check (range > 1 day), count once
    Object.values(map).forEach(entry => {
      // Already accumulated per-day; divide by window size to avoid double counting
    });
    return map;
  }

  function checksOnDay(dayIso: string): { c1: [number, number]; c2: [number, number]; c3: [number, number]; sources: { srcIso: string; checks: string[]; snapped: boolean }[] } {
    const targetIso = snapToWeekday(dayIso);
    // For each source date, compute which checks land on targetIso
    const result: { srcIso: string; checks: string[]; snapped: boolean }[] = [];
    let c1 = 0, c2 = 0, c3 = 0;
    Object.entries(dailyReceived).forEach(([srcIso, count]) => {
      if (!count) return;
      const checks: string[] = [];
      let snapped = false;
      if (snapToWeekday(addBizDays(srcIso, c1Min)) === targetIso || snapToWeekday(addBizDays(srcIso, c1Max)) === targetIso) {
        // Check if any day in c1 window snaps to targetIso
        for (let d = c1Min; d <= c1Max; d++) {
          if (snapToWeekday(addBizDays(srcIso, d)) === targetIso) {
            const natural = addBizDays(srcIso, d);
            if (natural !== targetIso) snapped = true;
            checks.push('c1'); c1 += count; break;
          }
        }
      }
      if (snapToWeekday(addBizDays(srcIso, c2Min)) === targetIso || snapToWeekday(addBizDays(srcIso, c2Max)) === targetIso) {
        for (let d = c2Min; d <= c2Max; d++) {
          if (snapToWeekday(addBizDays(srcIso, d)) === targetIso) {
            const natural = addBizDays(srcIso, d);
            if (natural !== targetIso) snapped = true;
            checks.push('c2'); c2 += count; break;
          }
        }
      }
      if (snapToWeekday(addBizDays(srcIso, c3Min)) === targetIso || snapToWeekday(addBizDays(srcIso, c3Max)) === targetIso) {
        for (let d = c3Min; d <= c3Max; d++) {
          if (snapToWeekday(addBizDays(srcIso, d)) === targetIso) {
            const natural = addBizDays(srcIso, d);
            if (natural !== targetIso) snapped = true;
            checks.push('c3'); c3 += count; break;
          }
        }
      }
      if (checks.length) result.push({ srcIso, checks, snapped });
    });
    return { c1: [c1, c1], c2: [c2, c2], c3: [c3, c3], sources: result };
  }

  function setDayPct(i: number, val: number) {
    const next = [...dayPcts]; next[i] = val;
    onPresSettingsChange({ ...presSettings, dayPcts: next });
  }
  function setDayOverride(iso: string, locKey: 'ut' | 'ga', val: number | null) {
    const next = { ...dayOverrides };
    if (val === null) {
      const existing = next[iso];
      if (existing) {
        next[iso] = { ...existing, [locKey]: 0 };
      }
    } else {
      next[iso] = { ut: next[iso]?.ut ?? 0, ga: next[iso]?.ga ?? 0, [locKey]: val };
    }
    onPresSettingsChange({ ...presSettings, dayOverrides: next });
  }

  function setDateFrom(v: string) { onPresSettingsChange({ ...presSettings, dateFrom: v }); }
  function setDateTo(v: string)   { onPresSettingsChange({ ...presSettings, dateTo: v }); }

  // ── Shopify event-date fetch (replaces parseDateRange mock) ──────────────────
  const [shopifyByDate, setShopifyByDate] = useState<Record<string, { count: number; gaCount: number; utahCount: number }>>({});
  const [shopifyTotal,  setShopifyTotal]  = useState(0);
  const [shopifyLoading, setShopifyLoading] = useState(false);
  const [shopifyError,   setShopifyError]   = useState('');

  // ── Forecast: expected final total based on days-after-event order curve ───────
  const [forecastExpected,  setForecastExpected]  = useState<number | null>(null);
  const [forecastStill,     setForecastStill]     = useState<number | null>(null);
  const [forecastLoading,   setForecastLoading]   = useState(false);

  function loadForecast(currentCount: number, from: string, to: string) {
    if (currentCount === 0) { setForecastExpected(null); setForecastStill(null); return; }
    setForecastLoading(true);
    fetch(`/api/event-date-forecast?start=${from}&end=${to}&currentCount=${currentCount}`)
      .then(r => r.json())
      .then((d: { projection?: { expected: number; stillExpected: number } }) => {
        if (d.projection) {
          setForecastExpected(d.projection.expected);
          setForecastStill(d.projection.stillExpected);
        } else {
          setForecastExpected(null);
          setForecastStill(null);
        }
      })
      .catch(() => {})
      .finally(() => setForecastLoading(false));
  }

  function loadRange(from: string, to: string) {
    setShopifyLoading(true);
    setShopifyError('');
    fetch(`/api/event-date-orders?start=${from}&end=${to}`)
      .then(r => r.json())
      .then((d: { byDate?: Record<string, { count: number; gaCount: number; utahCount: number }>; total?: number; error?: string }) => {
        if (d.error) { setShopifyError(d.error); return; }
        setShopifyByDate(d.byDate ?? {});
        setShopifyTotal(d.total ?? 0);
        loadForecast(d.total ?? 0, from, to);
      })
      .catch(e => setShopifyError(String(e)))
      .finally(() => setShopifyLoading(false));
  }

  // Load on mount and when date range changes
  useEffect(() => { loadRange(dateFrom, dateTo); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function setQuick(mode: string) {
    const d = new Date(); const dow = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    let from: Date, to: Date;
    if (mode === 'thisweek')      { from = mon; to = new Date(mon); to.setDate(mon.getDate() + 6); }
    else if (mode === 'nextweek') { from = new Date(mon); from.setDate(mon.getDate() + 7); to = new Date(from); to.setDate(from.getDate() + 6); }
    else if (mode === 'next2')    { from = new Date(mon); from.setDate(mon.getDate() + 7); to = new Date(from); to.setDate(from.getDate() + 13); }
    else { from = new Date(d.getFullYear(), d.getMonth(), 1); to = new Date(d.getFullYear(), d.getMonth() + 1, 0); }
    const f = from.toISOString().split('T')[0]; const t = to.toISOString().split('T')[0];
    setDateFrom(f); setDateTo(t); loadRange(f, t);
  }

  // Total Utah/Georgia from loaded Shopify range
  const totalUtahLoaded = Object.values(shopifyByDate).reduce((s, d) => s + d.utahCount, 0);
  const totalGaLoaded   = Object.values(shopifyByDate).reduce((s, d) => s + d.gaCount,   0);

  // Build 5 weekdays starting from the loaded dateFrom
  const fiveDays = (() => {
    const days: { iso: string; utahEst: number; gaEst: number; utahDefault: number; gaDefault: number; label: string; dateStr: string }[] = [];
    // Use presThisWeekOffset to support toggling forward through the end of the year
    const _today = new Date();
    _today.setHours(0, 0, 0, 0);
    const _dow = _today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const _daysToMon = _dow === 0 ? -6 : 1 - _dow;
    const _mon = new Date(_today);
    _mon.setDate(_today.getDate() + _daysToMon + presThisWeekOffset * 7);
    const d = new Date(_mon.getFullYear(), _mon.getMonth(), _mon.getDate(), 12, 0, 0);
    let dayIdx = 0;
    while (days.length < 7) {
      const dow = d.getDay();
      if (true || dow !== 0 && dow !== 6) { // include all 7 days
        const iso = d.toISOString().split('T')[0];
        const pct = (dayPcts[dayIdx] ?? 0) / 100;
        const utahDefault = Math.round(totalUtahLoaded * pct);
        const gaDefault   = Math.round(totalGaLoaded   * pct);
        const override    = dayOverrides[iso];
        days.push({
          iso,
          utahEst:     override?.ut !== undefined ? override.ut : utahDefault,
          gaEst:       override?.ga !== undefined ? override.ga : gaDefault,
          utahDefault,
          gaDefault,
          label:   d.toLocaleDateString('en-US', { weekday: 'short' }),
          dateStr: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        });
        dayIdx++;
      }
      d.setDate(d.getDate() + 1);
    }
    return days;
  })();

  // Compute per-WEEK Shopify-derived estimates for the 52-week grid
  // For each future week, sum event-date orders by ga tag within that Mon–Sun window
  // (We fetch on demand when user loads a range; for 52-week we use the overrides + a simple sum)
  const [weeklyShopify, setWeeklyShopify] = useState<Record<string, { ut: number; ga: number }>>({});
  const [weeklyShopifyLoading, setWeeklyShopifyLoading] = useState(false);

  function loadWeeklyShopify() {
    // Fetch next 52 weeks of event-date data all at once
    const from = isoMonday(0);
    const to   = addDays(isoMonday(51), 6);
    setWeeklyShopifyLoading(true);
    fetch(`/api/event-date-orders?start=${from}&end=${to}`)
      .then(r => r.json())
      .then((d: { byDate?: Record<string, { count: number; gaCount: number; utahCount: number }>; error?: string }) => {
        if (d.error || !d.byDate) return;
        // Bucket each date into its Mon–Sun week
        const map: Record<string, { ut: number; ga: number }> = {};
        Object.entries(d.byDate).forEach(([dateIso, counts]) => {
          const date = new Date(dateIso + 'T12:00:00');
          const dow = date.getDay();
          const diff = dow === 0 ? -6 : 1 - dow;
          const mon = new Date(date); mon.setDate(date.getDate() + diff);
          const weekKey = mon.toISOString().split('T')[0];
          if (!map[weekKey]) map[weekKey] = { ut: 0, ga: 0 };
          map[weekKey].ut += counts.utahCount;
          map[weekKey].ga += counts.gaCount;
        });
        setWeeklyShopify(map);
      })
      .catch(() => {})
      .finally(() => setWeeklyShopifyLoading(false));
  }

  // Merge persisted roster + hours over defaults
  const defaultTeam = location === 'Utah' ? UTAH_PRESERVATION_TEAM : GEORGIA_PRESERVATION_TEAM;

  // Build team including any added members from presRoster that aren't in defaultTeam
  // `hours` is now date-keyed (isoMonday -> hours); `defaultHrs` is the fallback
  // used when a member has no persisted entry for a given week yet.
  // `includeRemoved: true` returns everyone who's ever been on the roster
  // (including soft-deleted members) — used only for historicals, so past
  // scheduled-hours/goal data doesn't vanish when someone leaves.
  const buildPresTeam = (includeRemoved: boolean): (Omit<PresTeamMember, 'hours'> & { hours: Record<string, number>; defaultHrs: number })[] => {
    const base = defaultTeam
      .filter(m => includeRemoved || !presRoster[m.id]?._removed)
      .map(m => {
        const roster = presRoster[m.id];
        const hours  = presHours[m.id] ?? {};
        return { ...m, ratio: roster?.ratio ?? m.ratio, rate: roster?.rate > 0 ? roster.rate : (employeeRates[roster?.name ?? m.name]?.hourlyRate ?? m.rate), hours, defaultHrs: m.hours[0] ?? 0 };
      });
    // Add any custom members stored in presRoster not in defaultTeam
    const defaultIds = new Set(defaultTeam.map(m => m.id));
    Object.entries(presRoster).forEach(([id, r]) => {
      if (!defaultIds.has(id) && (includeRemoved || !r._removed)) {
        base.push({
          id, name: r.name, ratio: r.ratio, rate: r.rate > 0 ? r.rate : (employeeRates[r.name]?.hourlyRate ?? 0),
          payType: (r.payType ?? 'hourly') as 'hourly' | 'salary',
          annualSalary: r.annualSalary ?? 0,
          hours: presHours[id] ?? {},
          defaultHrs: 0,
        } as PresTeamMember & { hours: Record<string, number>; defaultHrs: number });
      }
    });
    return base;
  };
  const team = buildPresTeam(false);
  const fullTeam = buildPresTeam(true);

  // ── Weekly Preservation capacity (orders/bouquets), 52 weeks ───────────────
  // Same resolveWeekHours chain the 52-week planner reads per-cell, summed
  // across the team, so the Queue & Turnaround simulation can't disagree
  // with what the schedule actually shows.
  const presCapacityByWeek = useMemo(() => Array.from({ length: WEEKS }, (_, w) => {
    const weekIso = isoMonday(w);
    let totalOrders = 0, totalHours = 0;
    team.forEach(m => {
      const prodH = resolveWeekHours({
        dailyMap: presDailyHours, weekKey: `${weekIso}-${m.id}`,
        legacyWeeklyValue: presHours[m.id]?.[weekIso],
        standardWeeklyHours: presRoster[m.id]?.standardWeeklyHours,
        hardcodedDefault: m.defaultHrs,
        employment: { weekIso, startDate: presRoster[m.id]?.startDate, endDate: presRoster[m.id]?.endDate },
      });
      totalOrders += m.ratio > 0 ? prodH / m.ratio : 0;
      totalHours  += prodH;
    });
    return { totalOrders, totalHours };
  }), [team, presDailyHours, presHours, presRoster]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Hiring / what-if plan ────────────────────────────────────────────────────
  // Mirrors Design's/Fulfillment's hiringPlan. Arrivals are the shared
  // bouquetsReceivedByWeek estimate (same numbers as Design's "Bouquets
  // received" column), starting queue is the live count of orders already
  // sitting in Preservation right now. No fixed floor before Preservation can
  // act on a bouquet, so this reuses the unclamped FIFO simulator directly.
  const presHiringPlan = useMemo(() => {
    const baseCapacity = presCapacityByWeek.map(t => t.totalOrders);
    const baseHours    = presCapacityByWeek.map(t => t.totalHours);

    let cumulativeHireHours = 0;
    const hireHoursByWeek: number[] = [];
    for (let w = 0; w < WEEKS; w++) {
      cumulativeHireHours += presNewHireHours[isoMonday(w)] ?? 0;
      hireHoursByWeek.push(cumulativeHireHours);
    }

    const scheduledHours = baseHours;
    const plannedHours   = baseHours.map((h, w) => h + hireHoursByWeek[w]);
    const planCapacity   = baseCapacity.map((c, w) => c + hireHoursByWeek[w] / PRES_NEW_HIRE_RATIO);

    const scheduledTurnaround = simulateDesignTurnaroundsUnclamped(preservationQueue, bouquetsReceivedByWeek, baseCapacity);
    const planTurnaround      = simulateDesignTurnaroundsUnclamped(preservationQueue, bouquetsReceivedByWeek, planCapacity);

    return { scheduledHours, plannedHours, hireHoursByWeek, scheduledTurnaround, planTurnaround };
  }, [presCapacityByWeek, presNewHireHours, preservationQueue, bouquetsReceivedByWeek]);

  function setPresNewHireHours(weekIso: string, hours: number) {
    const next = { ...presNewHireHours };
    if (hours > 0) next[weekIso] = hours; else delete next[weekIso];
    onPresNewHireHoursChange(next);
  }

  function updateDailyHours(memberId: string, dayIdx: number, val: number) {
    const weekIso = isoMonday(presThisWeekOffset);
    const key = `${weekIso}-${memberId}`;
    const padded = [...baseDailyArray(presDailyHours, key, presHours[memberId]?.[weekIso], isoMonday(0))];
    padded[dayIdx] = val;
    onPresDailyHoursChange({ ...presDailyHours, [key]: padded });
  }

  function updateCheckHours(memberId: string, dayIdx: number, val: number) {
    const key = `${isoMonday(presThisWeekOffset)}-${memberId}`;
    const newHours = { ...presCheckHours, [key]: [...(presCheckHours[key] ?? Array(7).fill(0))] };
    newHours[key][dayIdx] = val;
    onPresCheckHoursChange(newHours);
  }

  // Same idea as Design's resolveMgrTotalWeekHours: a day's fallback is that
  // day's already-resolved PRODUCTION hours, not a flat template.
  function resolvePresMgrTotalWeekHours(weekIdx: number, memberId: string, productionHrs: number): number {
    const weekIso = isoMonday(weekIdx);
    const weekKey = `${weekIso}-${memberId}`;
    const dailyOverrides = mgrTotalDailyHours[weekKey];
    if (dailyOverrides !== undefined) {
      let sum = 0;
      for (let day = 0; day < 7; day++) {
        const override = dailyOverrides[day];
        sum += override != null ? override
          : resolveDayHours(presDailyHours, `${weekIso}-${memberId}`, day, presRoster[memberId]?.standardWeeklyHours,
              { weekIso, startDate: presRoster[memberId]?.startDate, endDate: presRoster[memberId]?.endDate }).hours;
      }
      return sum;
    }
    return mgrTotalHours[memberId]?.[weekIso] ?? productionHrs;
  }

  function updateRoster(memberId: string, field: 'ratio' | 'rate' | 'name' | 'payType' | 'annualSalary' | 'role' | 'excludeFromCost' | 'startDate' | 'endDate', val: string | number | boolean) {
    const existing = presRoster[memberId] ?? { ratio: 1, rate: 0, name: 'Team Member', payType: 'hourly' as const, annualSalary: 0 };
    onPresRosterChange({ ...presRoster, [memberId]: { ...existing, [field]: val } });
  }
  function updateTemplate(memberId: string, dayIdx: number, value: number) {
    const existing = presRoster[memberId] ?? { ratio: 1, rate: 0, name: 'Team Member' };
    const prevTemplate = existing.standardWeeklyHours ?? [0, 0, 0, 0, 0, 0, 0];
    const nextTemplate = prevTemplate.map((h, j) => j === dayIdx ? value : h);
    onPresRosterChange({ ...presRoster, [memberId]: { ...existing, standardWeeklyHours: nextTemplate } });

    // Legacy per-week values (presHours) predate the standard-schedule
    // template and outrank it in resolveWeekHours — nothing in the current
    // UI writes new ones, so any left on a future week are stale
    // pre-template leftovers silently shadowing the template. Release just
    // those (current week forward, past weeks kept as historical record) so
    // a template edit actually takes effect. A week the manager has
    // genuinely touched via "This Week" has a real presDailyHours entry —
    // untouched here, so intentional day-level overrides never get wiped.
    const legacyForMember = presHours[memberId];
    if (legacyForMember) {
      const nextLegacy = { ...legacyForMember };
      let changed = false;
      const currentWeekIso = isoMonday(0);
      for (let w = 0; w < WEEKS; w++) {
        const weekIso = isoMonday(w);
        if (weekIso < currentWeekIso) continue;
        if (nextLegacy[weekIso] === undefined) continue;
        if (presDailyHours[`${weekIso}-${memberId}`]) continue;
        delete nextLegacy[weekIso];
        changed = true;
      }
      if (changed) onPresHoursChange({ ...presHours, [memberId]: nextLegacy });
    }
  }
  // Clears every frozen day/week override for this member from the current
  // week forward (past weeks untouched) so they fall back to the template.
  function resetMemberToTemplate(memberId: string) {
    if (!window.confirm('Clear this person’s scheduled hours from this week forward and go back to following their standard schedule? Past weeks are not affected.')) return;
    const newDaily = { ...presDailyHours };
    let changedDaily = false;
    const newWeekly = { ...presHours };
    let changedWeekly = false;
    for (let w = 0; w < WEEKS; w++) {
      const weekIso = isoMonday(w);
      const dailyKey = `${weekIso}-${memberId}`;
      if (newDaily[dailyKey]) { delete newDaily[dailyKey]; changedDaily = true; }
      if (newWeekly[memberId]?.[weekIso] !== undefined) {
        newWeekly[memberId] = { ...newWeekly[memberId] };
        delete newWeekly[memberId][weekIso];
        changedWeekly = true;
      }
    }
    if (changedDaily) onPresDailyHoursChange({ ...newDaily });
    if (changedWeekly) onPresHoursChange(newWeekly);
  }

  function handleAddMember() {
    const id = `${location.toLowerCase()}-p-${Date.now()}`;
    onPresRosterChange({ ...presRoster, [id]: { id, name: 'New Member', ratio: 0.7, rate: 0 } as typeof presRoster[string] });
    onPresHoursChange({ ...presHours, [id]: {} });
  }

  function handleRemoveMember(id: string) {
    // Soft-delete: mark as removed so they drop off the active roster, but
    // keep their roster entry and scheduledHours intact — historicals still
    // need those for past-period goal/CPO calculations.
    const newRoster = { ...presRoster };
    const existing = newRoster[id] ?? team.find(m => m.id === id) ?? { ratio: 1, rate: 0, name: '' };
    newRoster[id] = { ...existing, _removed: true } as typeof newRoster[string];
    onPresRosterChange(newRoster);
  }

  // Per-day hours (index 0–4 = Mon–Fri of current week)
  const dayTotals = Array.from({ length: 7 }, (_, di) => {
    const weekIso = isoMonday(presThisWeekOffset);
    return team.reduce((s, m) => s + (m.ratio > 0
      ? resolveDayHours(presDailyHours, `${weekIso}-${m.id}`, di, presRoster[m.id]?.standardWeeklyHours,
          { weekIso, startDate: presRoster[m.id]?.startDate, endDate: presRoster[m.id]?.endDate }).hours / m.ratio
      : 0), 0);
  });
  // Total check hours scheduled per day — no standard template for checks
  const checkDayTotals = Array.from({ length: 7 }, (_, di) =>
    team.reduce((s, m) => s + (presCheckHours[`${isoMonday(presThisWeekOffset)}-${m.id}`]?.[di] ?? 0), 0)
  );

  // Per-week totals for 52-week grid — This Week overrides -> standard
  // template -> legacy pre-cutover weekly value -> hardcoded default.
  const weeklyTotals = Array.from({ length: WEEKS }, (_, w) => {
    const weekIso = isoMonday(w);
    return team.reduce((s, m) => s + (m.ratio > 0 ? resolveWeekHours({
      dailyMap: presDailyHours, weekKey: `${weekIso}-${m.id}`,
      legacyWeeklyValue: m.hours[weekIso],
      standardWeeklyHours: presRoster[m.id]?.standardWeeklyHours,
      hardcodedDefault: m.defaultHrs,
      employment: { weekIso, startDate: presRoster[m.id]?.startDate, endDate: presRoster[m.id]?.endDate },
    }) / m.ratio : 0), 0);
  });

  const windowWeeks = Array.from({ length: WINDOW }, (_, i) => i + weekOffset).filter(i => i < WEEKS);
  const hasRates = canViewCPO && team.some(m => m.rate > 0);

  const tagStyle: Record<string, string> = {
    hourly: 'bg-slate-100 text-slate-600',
    flex:   'bg-indigo-100 text-indigo-700',
    oncall: 'bg-pink-100 text-pink-700',
  };

  const locKey = location === 'Utah' ? 'ut' : 'ga';

  return (
    <div className="space-y-4">

      {/* Date range picker */}
      <div className="bg-white border border-slate-100 rounded-xl p-4">
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span className="text-xs font-medium text-slate-500">Event date range</span>
          {(['thisweek','nextweek','next2','thismonth'] as const).map((m, i) => (
            <button key={m} onClick={() => setQuick(m)}
              className="text-xs px-3 py-1 border border-slate-200 rounded-full text-slate-600 hover:bg-slate-50 transition-colors">
              {['This week','Next week','Next 2 wks','This month'][i]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="border border-slate-200 rounded px-2 py-1.5 text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
          <span className="text-xs text-slate-400">to</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="border border-slate-200 rounded px-2 py-1.5 text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
          <button onClick={() => loadRange(dateFrom, dateTo)} disabled={shopifyLoading}
            className="px-4 py-1.5 text-xs font-medium bg-rose-700 text-white rounded hover:bg-rose-800 disabled:opacity-50 transition-colors">
            {shopifyLoading ? 'Loading…' : 'Load'}
          </button>
          {shopifyError && <span className="text-xs text-red-500">{shopifyError}</span>}
        </div>
        {shopifyTotal > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-100 flex gap-6 flex-wrap">
            <div><p className="text-xs text-slate-400">Total</p><p className="text-lg font-semibold text-slate-700">{shopifyTotal}</p></div>
            <div><p className="text-xs text-slate-400">Utah (no ga tag)</p><p className="text-lg font-semibold text-indigo-700">{Object.values(shopifyByDate).reduce((s,d)=>s+d.utahCount,0)}</p></div>
            <div><p className="text-xs text-slate-400">Georgia (ga tag)</p><p className="text-lg font-semibold text-indigo-700">{Object.values(shopifyByDate).reduce((s,d)=>s+d.gaCount,0)}</p></div>
          </div>
        )}
      </div>

      {/* Tabs: Schedule | Queue & Turnaround | Historicals */}
      {userRole !== 'viewer' && (
        <div className="flex border-b border-slate-200">
          {(['schedule', 'queue', 'historicals'] as const).map(t => (
            <button key={t} onClick={() => setPresTab(t)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                presTab === t ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}>{t === 'schedule' ? 'Schedule' : t === 'queue' ? 'Queue & Turnaround' : 'Historicals'}</button>
          ))}
        </div>
      )}

      {presTab === 'schedule' && (
        <div className="space-y-4">

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-100 rounded-xl p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">Event-date orders loaded</p>
              <p className="text-xs text-slate-400 mb-2">{dateFrom} → {dateTo}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xl font-semibold text-rose-700">{shopifyLoading ? '…' : shopifyTotal}</p>
                {shopifyTotal > 0 && <span className="text-[10px] bg-rose-100 text-rose-600 rounded px-1.5 py-0.5">live</span>}
                {forecastLoading && <span className="text-xs text-slate-300 italic">forecasting…</span>}
                {!forecastLoading && forecastExpected !== null && forecastExpected > shopifyTotal && (
                  <span className="text-sm font-medium text-slate-500">
                    ~{forecastExpected} expected
                    {forecastStill !== null && forecastStill > 0 && (
                      <span className="ml-1 text-xs text-slate-400">(+{forecastStill} more coming)</span>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Day % distribution + 5-day editable grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-slate-700 mb-1">Arrival % by day of week</h3>
              <p className="text-xs text-slate-400 mb-3">% of orders arriving each day. Should total 100%.</p>
              <div className="space-y-2">
                {dayNames.map((name, i) => (
                  <div key={name} className="flex items-center gap-3">
                    <span className="text-xs text-slate-500 w-20">{name}</span>
                    <input type="number" value={dayPcts[i]} min="0" max="100"
                      onChange={e => setDayPct(i, parseFloat(e.target.value) || 0)}
                      className="w-14 border border-slate-200 rounded px-2 py-1 text-sm text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                    <span className="text-xs text-slate-400">%</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-slate-400">Total:</span>
                <span className={`text-xs font-semibold ${dayPcts.reduce((a,b)=>a+b,0) === 100 ? 'text-green-700' : 'text-red-600'}`}>{dayPcts.reduce((a,b)=>a+b,0)}%</span>
              </div>
            </div>

            <div className="bg-white border border-slate-100 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-slate-700 mb-1">Est. deliveries — {location}</h3>
              <p className="text-xs text-slate-400 mb-3">
                {shopifyTotal > 0
                  ? `${location === 'Utah' ? totalUtahLoaded : totalGaLoaded} ${location} orders in range · edit any day to override`
                  : 'Load an event date range above first.'}
              </p>
              <div className="space-y-2">
                {fiveDays.map((d) => {
                  const locKey = location === 'Utah' ? 'ut' : 'ga';
                  const def = location === 'Utah' ? d.utahDefault : d.gaDefault;
                  const est = location === 'Utah' ? d.utahEst     : d.gaEst;
                  const isOverridden = dayOverrides[d.iso]?.[locKey] !== undefined;
                  return (
                    <div key={d.iso} className="flex items-center gap-2">
                      <span className="text-xs text-slate-500 w-24">{d.label} <span className="text-slate-300 text-[10px]">{d.dateStr}</span></span>
                      <input
                        type="number" min="0"
                        value={est}
                        onChange={e => setDayOverride(d.iso, locKey, parseInt(e.target.value) || 0)}
                        className="w-16 border border-slate-200 rounded px-2 py-1 text-sm text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300"
                      />
                      {isOverridden && (
                        <span className="text-[10px] text-slate-300">def: {def}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Roster editor */}
          <div>
            <button onClick={() => setShowRoster(r => !r)} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
              {showRoster ? '▲ Hide' : '▼ Edit'} preservation roster, ratios &amp; pay rates
            </button>
            {showRoster && (
              <div className="mt-3 bg-white border border-slate-100 rounded-xl p-5">
                <PresRosterEditor
                  team={team}
                  presRoster={presRoster}
                  deptLocation={location}
                  onUpdateRoster={updateRoster}
                  onTemplateChange={updateTemplate}
                  onResetToTemplate={resetMemberToTemplate}
                  onRemove={handleRemoveMember}
                  employeeRates={employeeRates}
                  onRefreshRatio={async (id, name) => {
                    try {
                      const res = await fetch(`/api/actuals?location=${location}&type=team&weeks=100`);
                      const data = await res.json() as { teamActuals?: { department: string; week_of: string; member_name: string; actual_hours: number; actual_orders: number }[] };
                      const rows = (data.teamActuals ?? []).filter(r => r.department === 'preservation' && r.member_name === name).sort((a, b) => b.week_of.localeCompare(a.week_of)).slice(0, 4);
                      const h = rows.reduce((s, r) => s + r.actual_hours, 0);
                      const o = rows.reduce((s, r) => s + r.actual_orders, 0);
                      if (o > 0 && h > 0) updateRoster(id, 'ratio', Math.round(h / o * 100) / 100);
                    } catch {}
                  }}
                  onReorder={(newOrder) => {
                    const newRoster = { ...presRoster };
                    newOrder.forEach((id, i) => {
                      newRoster[id] = { ...(newRoster[id] ?? { ratio: 1, rate: 0, name: '' }), _order: i } as typeof newRoster[string];
                    });
                    onPresRosterChange(newRoster);
                  }}
                />
                <button onClick={handleAddMember}
                  className="mt-4 text-xs px-3 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 transition-colors">
                  + Add team member
                </button>
                <p className="mt-3 text-xs text-slate-400"><strong>Ratio:</strong> hours per order. e.g. 0.7 = 1 order takes 0.7 hrs.</p>
              </div>
            )}
          </div>

          {/* Check settings accordion */}
          <div className="border border-slate-100 rounded-xl bg-white overflow-hidden">
            <button
              onClick={() => setShowCheckSettings(s => !s)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
            >
              <span className="font-medium">Check schedule settings</span>
              <span className="text-slate-400 text-xs">{showCheckSettings ? '▲ Hide' : '▼ Edit'} check windows & times</span>
            </button>
            {showCheckSettings && (
              <div className="px-5 pb-5 border-t border-slate-100 space-y-4">
                <p className="text-xs text-slate-400 pt-3">
                  Define how many business days after delivery each check falls, and how many minutes each check takes.
                  Weekends are automatically skipped.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {([
                    { label: 'Check 1', minKey: 'c1Min', maxKey: 'c1Max', minsKey: 'c1Mins', minVal: c1Min, maxVal: c1Max, minsVal: c1Mins, color: 'text-violet-600' },
                    { label: 'Check 2', minKey: 'c2Min', maxKey: 'c2Max', minsKey: 'c2Mins', minVal: c2Min, maxVal: c2Max, minsVal: c2Mins, color: 'text-blue-600' },
                    { label: 'Check 3', minKey: 'c3Min', maxKey: 'c3Max', minsKey: 'c3Mins', minVal: c3Min, maxVal: c3Max, minsVal: c3Mins, color: 'text-indigo-600' },
                  ] as const).map(({ label, minKey, maxKey, minsKey, minVal, maxVal, minsVal, color }) => (
                    <div key={label} className="space-y-2">
                      <p className={`text-xs font-semibold ${color}`}>{label}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500 w-20">Day window</span>
                        <input type="number" min="1" max="30" value={minVal}
                          onChange={e => setCheckSetting(minKey, parseInt(e.target.value) || 1)}
                          className="w-12 border border-slate-200 rounded px-1.5 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                        <span className="text-xs text-slate-400">–</span>
                        <input type="number" min="1" max="30" value={maxVal}
                          onChange={e => setCheckSetting(maxKey, parseInt(e.target.value) || 1)}
                          className="w-12 border border-slate-200 rounded px-1.5 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                        <span className="text-xs text-slate-400">biz days</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500 w-20">Minutes each</span>
                        <input type="number" min="0.5" max="60" step="0.5" value={minsVal}
                          onChange={e => setCheckSetting(minsKey, parseFloat(e.target.value) || 1)}
                          className="w-16 border border-slate-200 rounded px-1.5 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                        <span className="text-xs text-slate-400">min</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Weekly / 52-week toggle */}
          <div className="flex gap-1">
            {(['weekly', '52week'] as const).filter(t => userRole !== 'viewer').map(t => (
              <button key={t} onClick={() => { setActivePresTab(t); if (t === '52week' && Object.keys(weeklyShopify).length === 0) loadWeeklyShopify(); }}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  activePresTab === t ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                {t === 'weekly' ? 'This week' : '52-week planner'}
              </button>
            ))}
          </div>

          {/* ── THIS WEEK VIEW ── */}
          {activePresTab === 'weekly' && (
            <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
                <h3 className="text-sm font-semibold text-slate-700">Hours per team member — {presThisWeekOffset === 0 ? 'this week' : presThisWeekOffset === 1 ? 'next week' : `week +${presThisWeekOffset}`}</h3>
                <div className="flex items-center gap-2">
                  {hasRates && <span className="text-xs text-slate-400 mr-2">CPO shown when rate is set</span>}
                  <InputModeToggle mode={presInputMode} onChange={setPresInputMode} unitLabel="Frames" />
                  <button onClick={() => setPresThisWeekOffset(Math.max(0, presThisWeekOffset - 1))} disabled={presThisWeekOffset === 0} className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
                  <button onClick={() => setPresThisWeekOffset(Math.min(maxPresThisWeekOffset, presThisWeekOffset + 1))} disabled={presThisWeekOffset >= maxPresThisWeekOffset} className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 min-w-[140px]">Team member</th>
                      {fiveDays.map((d, i) => (
                        <th key={i} className={`px-2 py-2 text-center font-medium min-w-[80px] whitespace-nowrap ${i === 0 ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500'}`}>
                          {d.label}<br /><span className="font-normal text-[10px]">{d.dateStr}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {team.map((m, mi) => (
                      <tr key={m.id} className={mi % 2 === 0 ? '' : 'bg-slate-50/40'}>
                        <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap">
                          <div className="font-medium text-slate-700">{m.name}</div>
                          <div className="text-slate-400">{m.ratio} h/ord
                            <span className={`ml-1.5 text-[10px] rounded px-1 py-px ${tagStyle[m.pay] ?? 'bg-slate-100 text-slate-600'}`}>{m.pay}</span>
                          </div>
                        </td>
                        {fiveDays.map((_, di) => {
                          const weekIso = isoMonday(presThisWeekOffset);
                          const dailyKey = `${weekIso}-${m.id}`;
                          const { hours: prodH, isOverride } = resolveDayHours(presDailyHours, dailyKey, di, presRoster[m.id]?.standardWeeklyHours,
                            { weekIso, startDate: presRoster[m.id]?.startDate, endDate: presRoster[m.id]?.endDate });
                          const checkH = presCheckHours[dailyKey]?.[di] ?? 0;
                          const totalProdH = prodH + checkH;
                          const totalH = m.isManager ? (mgrTotalDailyHours[dailyKey]?.[di] ?? totalProdH) : totalProdH;
                          const orders = m.ratio > 0 ? prodH / m.ratio : 0;
                          const hasRate = m.rate > 0 || m.annualSalary > 0;
                          const cost = m.payType === 'salary' ? m.annualSalary / 260 : totalH * m.rate;
                          const cpo = !m.isManager && hasRate && orders > 0 && cost > 0 ? cost / orders : null;
                          return (
                            <td key={di} className={`px-2 py-1.5 text-center ${di === 0 ? 'bg-indigo-50/30' : ''}`}>
                              <div className="flex items-center gap-1">
                                <div className="flex flex-col items-center">
                                  <span className="text-[8px] text-slate-300 mb-0.5">press</span>
                                  <input type="number"
                                    value={presInputMode === 'output' ? (orders ? round2(orders) : '') : (prodH || '')}
                                    placeholder="0" min="0" step={presInputMode === 'output' ? '0.1' : '0.5'}
                                    title={isOverride ? 'Explicit override for this day' : 'Following the standard weekly schedule — edit to override just this day'}
                                    onChange={e => {
                                      const raw = parseFloat(e.target.value) || 0;
                                      updateDailyHours(m.id, di, presInputMode === 'output' ? hoursFromOutput(raw, m.ratio) : raw);
                                    }}
                                    className={`w-12 border rounded px-1 py-1 text-center bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 ${
                                      isOverride ? 'border-slate-200 text-slate-700' : 'border-slate-100 text-slate-400 italic'
                                    }`} />
                                </div>
                                <div className="flex flex-col items-center">
                                  <span className="text-[8px] text-teal-400 mb-0.5">chk</span>
                                  <input type="number" value={(presCheckHours[dailyKey]?.[di] || '')} placeholder="0" min="0" step="0.5"
                                    title="Check hours"
                                    onChange={e => updateCheckHours(m.id, di, parseFloat(e.target.value) || 0)}
                                    className="w-12 border border-teal-200 rounded px-1 py-1 text-center text-teal-700 bg-teal-50/50 focus:outline-none focus:ring-1 focus:ring-teal-300" />
                                </div>
                              </div>
                              {m.isManager && (
                                <input type="number" value={totalH || ''} placeholder="total" min="0" step="0.5"
                                  title="Total hours (incl. managerial)"
                                  onChange={e => {
                                    const newH = { ...mgrTotalDailyHours, [dailyKey]: [...(mgrTotalDailyHours[dailyKey] ?? Array(7).fill(0))] };
                                    newH[dailyKey][di] = parseFloat(e.target.value) || 0;
                                    onMgrTotalDailyHoursChange(newH);
                                  }}
                                  className="w-14 mt-0.5 border border-violet-200 rounded px-1.5 py-0.5 text-center text-[10px] text-violet-600 bg-violet-50 focus:outline-none focus:ring-1 focus:ring-violet-300" />
                              )}
                              {presInputMode === 'output'
                                ? (prodH > 0 && <div className="text-slate-400 mt-0.5">{round2(prodH)}h</div>)
                                : (orders > 0 && <div className="text-slate-400 mt-0.5">{round2(orders)} ord</div>)}
                              {cpo !== null && <div className="text-amber-600 text-[10px]">{fmt$(cpo)}</div>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                      <td className="sticky left-0 bg-slate-50 px-4 py-2 text-xs text-slate-600">Daily capacity</td>
                      {fiveDays.map((d, di) => {
                        const cap = dayTotals[di];
                        const est = location === 'Utah' ? d.utahEst : d.gaEst;
                        const diff = cap - est;
                        const dayCost = team.reduce((s, m) => {
                          if (m.rate === 0 && m.annualSalary === 0) return s;
                          if ((presRoster[m.id] as {excludeFromCost?: boolean})?.excludeFromCost) return s;
                          const weekIso = isoMonday(presThisWeekOffset);
                          const dailyKey = `${weekIso}-${m.id}`;
                          const prodH = resolveDayHours(presDailyHours, dailyKey, di, presRoster[m.id]?.standardWeeklyHours,
                            { weekIso, startDate: presRoster[m.id]?.startDate, endDate: presRoster[m.id]?.endDate }).hours;
                          const chkH  = presCheckHours[dailyKey]?.[di] ?? 0;
                          const totalH = m.isManager ? (mgrTotalDailyHours[dailyKey]?.[di] ?? (prodH + chkH)) : (prodH + chkH);
                          return s + (m.payType === 'salary' ? m.annualSalary / 260 : totalH * m.rate);
                        }, 0);
                        const dayCPO = cap > 0 && dayCost > 0 ? dayCost / cap : null;
                        const dayHours = team.reduce((s, m) => {
                          const weekIso = isoMonday(presThisWeekOffset);
                          return s + resolveDayHours(presDailyHours, `${weekIso}-${m.id}`, di, presRoster[m.id]?.standardWeeklyHours,
                            { weekIso, startDate: presRoster[m.id]?.startDate, endDate: presRoster[m.id]?.endDate }).hours;
                        }, 0);
                        const dayRatio = cap > 0 ? dayHours / cap : null;
                        return (
                          <td key={di} className={`px-2 py-2 text-center ${di === 0 ? 'bg-indigo-50/50' : ''}`}>
                            <div className="text-indigo-700">{Math.round(cap * 100) / 100} ord</div>
                            {est > 0 && (
                              <div className={`text-[10px] font-medium ${diff > 0 ? 'text-green-700' : diff < 0 ? 'text-red-600' : 'text-amber-600'}`}>
                                {diff > 0 ? '+' : ''}{Math.round(diff * 100) / 100} vs est.
                              </div>
                            )}
                            {(() => {
                              const checksData = checksOnDay(d.iso);
                              const checkHrsNeeded = ((checksData.c1[0] * c1Mins) + (checksData.c2[0] * c2Mins) + (checksData.c3[0] * c3Mins)) / 60;
                              const checkHrsScheduled = team.reduce((s, m) => s + (presCheckHours[`${isoMonday(presThisWeekOffset)}-${m.id}`]?.[di] ?? 0), 0);
                              if (checkHrsNeeded <= 0 && checkHrsScheduled <= 0) return null;
                              const checkDiff = checkHrsScheduled - checkHrsNeeded;
                              return (
                                <div className="flex flex-col items-center gap-0.5 border-t border-teal-100 mt-0.5 pt-0.5">
                                  <div className="text-[10px] text-teal-600 font-medium">
                                    {Math.round(checkHrsScheduled * 10) / 10}h chk
                                  </div>
                                  {checkHrsNeeded > 0 && (
                                    <div className={`text-[9px] font-medium ${checkDiff >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                                      {checkDiff >= 0 ? '+' : ''}{Math.round(checkDiff * 10) / 10} vs {Math.round(checkHrsNeeded * 10) / 10}h need
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                            {dayRatio !== null && <div className="text-[10px] text-slate-500">{Math.round(dayRatio * 100) / 100} h/ord</div>}
                            {dayCPO !== null && <div className="text-[10px] text-amber-600">{fmt$(dayCPO)}</div>}
                          </td>
                        );
                      })}
                    </tr>
                    <tr className="bg-slate-50/50">
                      <td className="sticky left-0 bg-slate-50/50 px-4 py-1.5 text-[10px] text-slate-400">Est. deliveries</td>
                      {fiveDays.map((d, di) => {
                        const est = location === 'Utah' ? d.utahEst : d.gaEst;
                        return <td key={di} className="px-2 py-1.5 text-center text-[10px] text-slate-400">{est || '—'}</td>;
                      })}
                    </tr>
                    {/* ── Actual received row ── */}
                    <tr className="bg-emerald-50/40 border-t border-slate-100">
                      <td className="sticky left-0 bg-emerald-50/40 px-4 py-1.5">
                        <div className="text-[10px] font-medium text-emerald-700">Actual received</div>
                        <div className="text-[9px] text-slate-400">bouquets delivered</div>
                      </td>
                      {fiveDays.map((d, di) => {
                        const val = dailyReceived[d.iso] ?? '';
                        return (
                          <td key={di} className="px-2 py-1.5 text-center">
                            <input
                              type="number" min="0" placeholder="0"
                              value={val}
                              onChange={e => setDailyReceived(d.iso, parseInt(e.target.value) || 0)}
                              className="w-14 border border-emerald-200 rounded px-1.5 py-1 text-center text-[11px] text-emerald-800 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
                            />
                          </td>
                        );
                      })}
                    </tr>
                    {/* ── Check load rows ── */}
                    {[
                      { label: 'Check 1', key: 'c1' as const, color: 'text-violet-600', bg: 'bg-violet-50/30', mins: c1Mins, min: c1Min, max: c1Max },
                      { label: 'Check 2', key: 'c2' as const, color: 'text-blue-600',   bg: 'bg-blue-50/30',   mins: c2Mins, min: c2Min, max: c2Max },
                      { label: 'Check 3', key: 'c3' as const, color: 'text-indigo-600', bg: 'bg-indigo-50/30', mins: c3Mins, min: c3Min, max: c3Max },
                    ].map(({ label, key, color, bg, mins, min, max }) => (
                      <tr key={key} className={`${bg} border-t border-slate-50`}>
                        <td className={`sticky left-0 ${bg} px-4 py-1.5`}>
                          <div className={`text-[10px] font-medium ${color}`}>{label}</div>
                          <div className="text-[9px] text-slate-400">day {min}–{max} · {mins} min ea</div>
                        </td>
                        {fiveDays.map((d, di) => {
                          const dow = new Date(d.iso + 'T12:00:00').getDay();
                          const isWeekend = dow === 0 || dow === 6;
                          if (isWeekend) return <td key={di} className="px-2 py-1.5 text-center"><span className="text-[10px] text-slate-100">—</span></td>;
                          const checks = checksOnDay(d.iso);
                          const [lo, hi] = checks[key];
                          const totalMins = lo * mins;
                          const srcForKey = checks.sources.filter(s => s.checks.includes(key));
                          const fmtSrc = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                          return (
                            <td key={di} className="px-2 py-1.5 text-center">
                              {lo > 0 ? (
                                <div className="flex flex-col items-center gap-0.5">
                                  {srcForKey.map(s => (
                                    <div key={s.srcIso} className="flex flex-col items-center">
                                      <span className="text-[9px] text-slate-400">from {fmtSrc(s.srcIso)}</span>
                                      {s.snapped && (
                                        <span className="text-[8px] text-amber-500" title="Fell on weekend — moved to nearest weekday">
                                          * moved from weekend
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                  <span className={`text-[11px] font-semibold ${color}`}>
                                    {lo === hi ? lo : `${lo}–${hi}`}
                                  </span>
                                  <span className="text-[9px] text-slate-400">{Math.round(totalMins)} min</span>
                                </div>
                              ) : (
                                <span className="text-[10px] text-slate-200">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── 52-WEEK PLANNER ── */}
          {activePresTab === '52week' && (
            <div className="space-y-3">
              <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <h3 className="text-sm font-semibold text-slate-700">Hours per team member per week</h3>
                    {weeklyShopifyLoading && <span className="text-xs text-slate-400 italic">Loading event data…</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <InputModeToggle mode={presInputMode} onChange={setPresInputMode} unitLabel="Frames" />
                    <button onClick={() => setWeekOffset(Math.max(0, weekOffset - WINDOW))} disabled={weekOffset === 0}
                      className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
                    <span className="text-xs text-slate-400">
                      {getWeekLabel(weekOffset)} – {getWeekLabel(weekOffset + WINDOW - 1)}
                    </span>
                    <button onClick={() => setWeekOffset(Math.min(WEEKS - WINDOW, weekOffset + WINDOW))} disabled={weekOffset + WINDOW >= WEEKS}
                      className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-100">
                        <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap min-w-[140px]">Team member</th>
                        {windowWeeks.map(w => (
                          <th key={w} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[90px]">
                            {getWeekLabel(w)}
                            {w === 0 && <span className="ml-1 text-[10px] bg-indigo-100 text-indigo-600 rounded px-1">now</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {team.map((m, mi) => (
                        <tr key={m.id} className={`border-b border-slate-50 ${mi % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                          <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap">
                            <div className="font-medium text-slate-700">{m.name}</div>
                            <div className="text-slate-400">{m.ratio} h/ord</div>
                          </td>
                          {windowWeeks.map(w => {
                            const weekIso = isoMonday(w);
                            const prodH = resolveWeekHours({
                              dailyMap: presDailyHours, weekKey: `${weekIso}-${m.id}`,
                              legacyWeeklyValue: m.hours[weekIso],
                              standardWeeklyHours: presRoster[m.id]?.standardWeeklyHours,
                              hardcodedDefault: m.defaultHrs,
                              employment: { weekIso, startDate: presRoster[m.id]?.startDate, endDate: presRoster[m.id]?.endDate },
                            });
                            const totalH = m.isManager ? resolvePresMgrTotalWeekHours(w, m.id, prodH) : prodH;
                            const orders = m.ratio > 0 ? prodH / m.ratio : 0;
                            const cost = m.payType === 'salary' ? (m.annualSalary / 52) : totalH * m.rate;
                            const cpo = !m.isManager && orders > 0 && cost > 0 ? cost / orders : null;
                            return (
                              <td key={w} className={`px-2 py-1.5 text-center ${w === 0 ? 'bg-indigo-50/30' : ''}`}>
                                <div className="text-slate-700 font-medium" title="Set on the Roster (standard schedule) or the This Week tab (one-off exceptions) — the 52-week planner is a read-only view">
                                  {presInputMode === 'output' ? round2(orders) : round2(prodH)}
                                </div>
                                {m.isManager && totalH !== prodH && (
                                  <div className="text-[10px] text-violet-600">{round2(totalH)}h total</div>
                                )}
                                {presInputMode === 'output'
                                  ? (prodH > 0 && <div className="text-slate-400 mt-0.5">{round2(prodH)}h</div>)
                                  : (orders > 0 && <div className="text-slate-400 mt-0.5">{round2(orders)} ord</div>)}
                                {cpo !== null && <div className="text-amber-600 text-[10px]">{fmt$(cpo)}</div>}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      {/* Week totals row */}
                      <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                        <td className="sticky left-0 bg-slate-50 px-4 py-2 text-xs text-slate-600">Week total</td>
                        {windowWeeks.map(w => {
                          const weekIso = isoMonday(w);
                          const totalCost = team.reduce((s, m) => {
                            const prodH = resolveWeekHours({
                              dailyMap: presDailyHours, weekKey: `${weekIso}-${m.id}`,
                              legacyWeeklyValue: m.hours[weekIso],
                              standardWeeklyHours: presRoster[m.id]?.standardWeeklyHours,
                              hardcodedDefault: m.defaultHrs,
                              employment: { weekIso, startDate: presRoster[m.id]?.startDate, endDate: presRoster[m.id]?.endDate },
                            });
                            const totalH = m.isManager ? resolvePresMgrTotalWeekHours(w, m.id, prodH) : prodH;
                            return s + (m.payType === 'salary' ? m.annualSalary / 52 : totalH * m.rate);
                          }, 0);
                          const totalCPO = weeklyTotals[w] > 0 && totalCost > 0 ? totalCost / weeklyTotals[w] : null;
                          return (
                            <td key={w} className={`px-2 py-2 text-center ${w === 0 ? 'bg-indigo-50/50' : ''}`}>
                              <div className="text-indigo-700">{round2(weeklyTotals[w])} ord</div>
                              {totalCPO !== null && <div className="text-amber-600 text-[10px]">{fmt$(totalCPO)}</div>}
                            </td>
                          );
                        })}
                      </tr>
                      {/* Shopify bookings row — display only */}
                      <tr className="bg-slate-50/50">
                        <td className="sticky left-0 bg-slate-50/50 px-4 py-1.5 text-[10px] text-slate-400">
                          Shopify bookings
                        </td>
                        {windowWeeks.map(w => {
                          const weekIso = isoMonday(w);
                          const shopify = weeklyShopify[weekIso];
                          const defaultVal = shopify ? shopify[locKey] : null;
                          const override = weekOverrides[weekIso];
                          const displayVal = override ? override[locKey] : defaultVal;
                          return (
                            <td key={w} className="px-2 py-1.5 text-center">
                              <div className="flex flex-col items-center gap-0.5">
                                <input
                                  type="number" min="0" placeholder="—"
                                  value={override ? override[locKey] : ''}
                                  onChange={e => {
                                    const val = parseInt(e.target.value);
                                    const newOverrides = { ...weekOverrides };
                                    if (isNaN(val)) {
                                      delete newOverrides[weekIso];
                                    } else {
                                      newOverrides[weekIso] = {
                                        ut: location === 'Utah'    ? val : (weekOverrides[weekIso]?.ut ?? defaultVal ?? 0),
                                        ga: location === 'Georgia' ? val : (weekOverrides[weekIso]?.ga ?? defaultVal ?? 0),
                                      };
                                    }
                                    onPresSettingsChange({ ...presSettings, weekOverrides: newOverrides });
                                  }}
                                  className="w-14 border border-slate-200 rounded px-1 py-0.5 text-center text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-rose-300"
                                  title="Override Shopify booking estimate. Leave blank to use Shopify default."
                                />
                                {defaultVal !== null && override && (
                                  <span className="text-[9px] text-slate-300" title="Shopify default">
                                    def: {defaultVal}
                                  </span>
                                )}
                                {displayVal !== null && displayVal !== undefined && (
                                  <span className="text-[9px] text-slate-400">{displayVal}</span>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                      {/* Design bouquets received row — drives staffing check */}
                      <tr className="bg-indigo-50/30">
                        <td className="sticky left-0 bg-indigo-50/30 px-4 py-1.5 text-[10px] text-indigo-500 font-medium">
                          Bouquets received est.
                        </td>
                        {windowWeeks.map(w => {
                          const weekIso = isoMonday(w);
                          const _we = weeklyEstimates?.[weekIso]; const designEstimate = _we !== undefined ? (location === 'Utah' ? _we.ut : _we.ga) : null;
                          const isUnderstaffed = designEstimate !== null && weeklyTotals[w] < designEstimate;
                          return (
                            <td key={w} className="px-2 py-1.5 text-center">
                              {designEstimate !== null ? (
                                <div className="flex flex-col items-center gap-0.5">
                                  <span className="text-[11px] font-medium text-indigo-600">{designEstimate}</span>
                                  <div className={`text-[10px] font-medium ${!isUnderstaffed ? 'text-green-600' : 'text-red-500'}`}>
                                    {!isUnderstaffed ? '✓' : `${round2(designEstimate - weeklyTotals[w])} short`}
                                  </div>
                                </div>
                              ) : (
                                <span className="text-[10px] text-slate-300">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="text-xs text-slate-400">Right-click any hours cell to apply that value to all 52 weeks for that team member.</p>
            </div>
          )}

        </div>
      )}

      {/* ── QUEUE & TURNAROUND TAB ── */}
      {presTab === 'queue' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-100 rounded-xl p-5">
            <div className="flex items-start justify-between gap-2 flex-wrap mb-1">
              <h2 className="text-sm font-semibold text-slate-700">Future turnaround — bouquets arriving each week</h2>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Estimated weeks to receive/log each week&apos;s bouquets, using the same estimates as Design&apos;s &quot;Bouquets received&quot; column.
              Currently {preservationQueue.toLocaleString()}{countsLoading ? '…' : ''} bouquets waiting in Preservation right now (live count).
              Add a hypothetical hire below to see how Planned turnaround responds, for that week and every week after.
            </p>
            {(() => {
              const maxWeeksScale = Math.max(
                ...presHiringPlan.scheduledTurnaround.filter((t): t is number => t !== null),
                ...presHiringPlan.planTurnaround.filter((t): t is number => t !== null),
                PRES_TARGET_WEEKS,
              ) * 1.05;
              return (
                <div className="overflow-x-auto -mx-1">
                  <table className="min-w-full text-xs border-separate" style={{ borderSpacing: 0 }}>
                    <thead>
                      <tr className="text-slate-400">
                        <th className="text-left font-medium px-2 py-1.5 sticky left-0 bg-white whitespace-nowrap">Week</th>
                        <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">Bouquets received (est.)</th>
                        <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">New hire</th>
                        <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">Preservation hours</th>
                        <th className="text-left font-medium px-2 py-1.5 min-w-[220px]">Turnaround</th>
                      </tr>
                    </thead>
                    <tbody>
                      {presHiringPlan.planTurnaround.map((total, w) => {
                        const schedTotal = presHiringPlan.scheduledTurnaround[w];
                        const { bar, text, label } = preservationTurnaroundColors(total);
                        const schedColors = preservationTurnaroundColors(schedTotal);
                        const weekIso = isoMonday(w);
                        const scheduledH = presHiringPlan.scheduledHours[w];
                        const plannedH   = presHiringPlan.plannedHours[w];
                        const hireCum    = presHiringPlan.hireHoursByWeek[w];
                        return (
                          <tr key={w} className={`border-b border-slate-50 align-top ${w % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                            <td className="px-2 py-2 sticky left-0 bg-inherit whitespace-nowrap text-slate-500">
                              {getWeekLabel(w)}
                              {w === 0 && <span className="ml-1 text-[9px] bg-indigo-100 text-indigo-600 rounded px-1">now</span>}
                            </td>
                            <td className="px-2 py-2 whitespace-nowrap text-slate-600">
                              {Math.round(bouquetsReceivedByWeek[w])} bq
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number" min="0" step="1" placeholder="0"
                                  value={presNewHireHours[weekIso] ?? ''}
                                  onChange={e => setPresNewHireHours(weekIso, parseFloat(e.target.value) || 0)}
                                  className="w-14 border border-slate-200 rounded px-1.5 py-0.5 text-center text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-300"
                                  title="Hours/wk a hypothetical new hire starting this week would average"
                                />
                                <span className="text-[10px] text-slate-300">h/wk</span>
                              </div>
                              {hireCum > 0 && (
                                <div className="text-[10px] text-emerald-600 mt-0.5 whitespace-nowrap">+{Math.round(hireCum)}h/wk running</div>
                              )}
                            </td>
                            <td className="px-2 py-2 whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                <span className="text-slate-400 w-14 shrink-0">Scheduled</span>
                                <span className="text-slate-700 font-medium">{Math.round(scheduledH)}h</span>
                              </div>
                              <div className="flex items-center gap-1.5 mt-1">
                                <span className="text-emerald-600 w-14 shrink-0">Planned</span>
                                <span className="text-emerald-700 font-medium">{Math.round(plannedH)}h</span>
                              </div>
                            </td>
                            <td className="px-2 py-2">
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-slate-400 w-14 shrink-0">Scheduled</span>
                                  {schedTotal !== null ? (
                                    <>
                                      <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                                        <div className={`h-2 rounded-full ${schedColors.bar}`} style={{ width: `${Math.min(100, (schedTotal / maxWeeksScale) * 100)}%` }} />
                                      </div>
                                      <span className={`text-[10px] font-medium w-14 text-right shrink-0 ${schedColors.text}`}>{schedTotal}w</span>
                                    </>
                                  ) : (
                                    <span className="text-[10px] text-red-500 italic">52wk+</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-slate-400 w-14 shrink-0">Planned</span>
                                  {total !== null ? (
                                    <>
                                      <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                                        <div className={`h-2 rounded-full ${bar}`} style={{ width: `${Math.min(100, (total / maxWeeksScale) * 100)}%` }} />
                                      </div>
                                      <span className={`text-[10px] font-semibold w-14 text-right shrink-0 ${text}`}>{total}w</span>
                                    </>
                                  ) : (
                                    <span className="text-[10px] text-red-600 italic">52wk+</span>
                                  )}
                                </div>
                              </div>
                              {total !== null && (
                                <div className={`text-[10px] mt-0.5 ${text}`}>{label}</div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
            <div className="flex gap-4 mt-4 pt-3 border-t border-slate-100 flex-wrap">
              <span className="text-[10px] text-slate-500">Bouquets received: same estimate shown on Design&apos;s Queue &amp; Turnaround tab — edit it there, it updates here too.</span>
              <span className="text-[10px] text-slate-500 border-l border-slate-200 pl-4">Preservation hours: Scheduled = the real 52-week planner. Planned = Scheduled + any new hire above.</span>
              <span className="flex items-center gap-1.5 text-[10px] text-slate-500 border-l border-slate-200 pl-4"><span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" /> keeping pace</span>
              <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> ≤{PRES_TARGET_WEEKS} wk behind</span>
              <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-red-600 inline-block" /> &gt;{PRES_TARGET_WEEKS} wk behind</span>
            </div>
          </div>
        </div>
      )}

      {/* ── HISTORICALS TAB ── */}
      {presTab === 'historicals' && userRole !== 'viewer' && (
        <HistoricalsSection
          department="preservation"
          location={location}
          members={team.map(m => ({ id: m.id, name: m.name, payType: m.payType ?? 'hourly', hourlyRate: m.rate, annualSalary: m.annualSalary ?? 0, isManager: m.isManager, excludeFromCPO: (m as {excludeFromCPO?:boolean}).excludeFromCPO }))}
          ordersLabel="bouquets"
          excludeFromCPONames={['Zac Williams', 'Lauren Boyd']}
          presActuals={presActuals}
          onReceivedSaved={onReceivedSaved}
        />
      )}
    </div>
  );
}

// ─── FulfillmentSection ────────────────────────────────────────────────────────

function FulfillmentSection({ location, fulfillmentQueue, countsLoading, teamActuals, onActualsSaved,
  ffHours, ffRoster, mgrTotalHours, mgrTotalDailyHours, onFfHoursChange, onFfRosterChange, onMgrTotalHoursChange, onMgrTotalDailyHoursChange, employeeRates = {},
  ffDailyHoursProp, onFfDailyHoursChange, canViewCPO = true, userRole = 'admin',
  designWeeklyFrames, ffNewHireHours, onFfNewHireHoursChange }: {
  location:        'Utah' | 'Georgia';
  fulfillmentQueue: number;
  countsLoading:   boolean;
  teamActuals:     { department: string; week_of: string; member_name: string; actual_hours: number; actual_orders: number }[];
  onActualsSaved:  () => void;
  ffHours:              Record<string, Record<string, number>>;
  ffRoster:             Record<string, { ratio: number; rate: number; name: string; payType?: 'hourly'|'salary'; annualSalary?: number; _removed?: boolean; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }>;
  mgrTotalHours:        Record<string, Record<string, number>>;
  mgrTotalDailyHours:   DailyHoursMap;
  onFfHoursChange:      (h: Record<string, Record<string, number>>) => void;
  onFfRosterChange:     (r: Record<string, { ratio: number; rate: number; name: string; payType?: 'hourly'|'salary'; annualSalary?: number; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }>) => void;
  onMgrTotalHoursChange:(h: Record<string, Record<string, number>>) => void;
  onMgrTotalDailyHoursChange: (h: DailyHoursMap) => void;
  employeeRates?:        Record<string, { hourlyRate: number; annualSalary: number; payType: 'hourly'|'salary' }>;
  ffDailyHoursProp?:     DailyHoursMap;
  onFfDailyHoursChange?: (h: DailyHoursMap) => void;
  canViewCPO?:           boolean;
  userRole?:             string;
  // Design's own scheduled weekly output (frames/week, 52 weeks) — the
  // natural weekly "arrivals into Fulfillment" figure, since an order only
  // reaches Fulfillment once Design finishes it.
  designWeeklyFrames:    number[];
  ffNewHireHours:        Record<string, number>;
  onFfNewHireHoursChange:(h: Record<string, number>) => void;
}) {
  const [ffTab,      setFfTab]      = useState<'thisweek' | 'schedule' | 'queue' | 'historicals'>('thisweek');
  const [ffInputMode, setFfInputMode] = useState<InputMode>('hours');
  const [ffThisWeekOffset, setFfThisWeekOffset] = useState(0);
  const maxFfThisWeekOffset = WEEKS - 1;
  const [ffDailyHours, setFfDailyHours] = useState<DailyHoursMap>(ffDailyHoursProp ?? {});
  useEffect(() => { if (ffDailyHoursProp && Object.keys(ffDailyHoursProp).length > 0) setFfDailyHours(ffDailyHoursProp); }, [JSON.stringify(ffDailyHoursProp)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showRoster, setShowRoster] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);

  // Merge persisted roster + hours over defaults
  const defaultTeam = location === 'Utah' ? UTAH_FULFILLMENT_TEAM : GEORGIA_FULFILLMENT_TEAM;
  // `includeRemoved: true` returns everyone who's ever been on the roster
  // (including soft-deleted members) — used only for historicals, so past
  // scheduled-hours/goal data doesn't vanish when someone leaves.
  const buildFfTeam = (includeRemoved: boolean): (Omit<FfTeamMember, 'hours'> & { hours: Record<string, number>; defaultHrs: number })[] => {
    const base = defaultTeam
      .filter(m => includeRemoved || !ffRoster[m.id]?._removed)
      .map(m => {
        const roster = ffRoster[m.id];
        const hours  = ffHours[m.id] ?? {};
        return { ...m, ratio: roster?.ratio ?? m.ratio, rate: roster?.rate > 0 ? roster.rate : (employeeRates[roster?.name ?? m.name]?.hourlyRate ?? m.rate), name: roster?.name ?? m.name,
          payType: roster?.payType ?? 'hourly' as const,
          annualSalary: roster?.annualSalary ?? 0, hours, defaultHrs: m.hours[0] ?? 0 };
      });
    const defaultIds = new Set(defaultTeam.map(m => m.id));
    Object.entries(ffRoster).forEach(([id, r]) => {
      if (!defaultIds.has(id) && (includeRemoved || !r._removed)) {
        base.push({ id, name: r.name ?? 'New Member', ratio: r.ratio ?? 1.0, pay: 'hourly' as const,
          payType: r.payType ?? 'hourly' as const, annualSalary: r.annualSalary ?? 0,
        rate: r.rate > 0 ? r.rate : (employeeRates[r.name]?.hourlyRate ?? 0), hours: ffHours[id] ?? {}, defaultHrs: 0 });
      }
    });
    return base;
  };
  const team = buildFfTeam(false);
  const fullTeam = buildFfTeam(true);

  // ── Weekly fulfillment capacity (orders), 52 weeks ──────────────────────────
  // Same resolveWeekHours chain the Weekly Schedule tab reads per-cell, just
  // summed across the whole team so the Queue & Turnaround simulation below
  // can never disagree with what the schedule actually shows.
  const ffWeeklyTotals = useMemo(() => Array.from({ length: WEEKS }, (_, w) => {
    const weekIso = isoMonday(w);
    let totalOrders = 0, totalHours = 0;
    team.forEach(m => {
      const prodH = resolveWeekHours({
        dailyMap: ffDailyHours, weekKey: `${weekIso}-${m.id}`,
        legacyWeeklyValue: ffHours[m.id]?.[weekIso],
        standardWeeklyHours: ffRoster[m.id]?.standardWeeklyHours,
        hardcodedDefault: m.defaultHrs,
        employment: { weekIso, startDate: ffRoster[m.id]?.startDate, endDate: ffRoster[m.id]?.endDate },
      });
      totalOrders += m.ratio > 0 ? prodH / m.ratio : 0;
      totalHours  += prodH;
    });
    return { totalOrders, totalHours };
  }), [team, ffDailyHours, ffHours, ffRoster]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Weekly arrivals into Fulfillment (orders Design actually/plans to finish) ──
  // Priority: actual design output logged for that week (Design historicals),
  // else Design's own scheduled capacity for that week — the same numbers
  // driving Design's Queue & Turnaround tab, so the two views can't disagree
  // about how many orders are headed downstream.
  const designOutputByWeek = useMemo(() => {
    const actualByWeek: Record<string, number> = {};
    teamActuals.filter(r => r.department === 'design').forEach(r => {
      actualByWeek[r.week_of] = (actualByWeek[r.week_of] ?? 0) + (r.actual_orders ?? 0);
    });
    return Array.from({ length: WEEKS }, (_, w) => actualByWeek[isoMonday(w)] ?? designWeeklyFrames[w] ?? 0);
  }, [teamActuals, designWeeklyFrames]);

  // ── Hiring / what-if plan ────────────────────────────────────────────────────
  // Mirrors Design's hiringPlan: the only manager-editable lever is a
  // hypothetical new hire's hours/wk, carried forward once they'd start.
  // "Planned" is always exactly Scheduled + those hire hours, same capacity
  // driving the Planned turnaround bar. Unlike Design there's no fixed
  // drying-time floor before Fulfillment can act on an order, so this reuses
  // the unclamped FIFO simulator directly (no PRESERVATION_WEEKS offset).
  const ffHiringPlan = useMemo(() => {
    const baseCapacity = ffWeeklyTotals.map(t => t.totalOrders);
    const baseHours    = ffWeeklyTotals.map(t => t.totalHours);

    let cumulativeHireHours = 0;
    const hireHoursByWeek: number[] = [];
    for (let w = 0; w < WEEKS; w++) {
      cumulativeHireHours += ffNewHireHours[isoMonday(w)] ?? 0;
      hireHoursByWeek.push(cumulativeHireHours);
    }

    const scheduledHours = baseHours;
    const plannedHours   = baseHours.map((h, w) => h + hireHoursByWeek[w]);
    const planCapacity   = baseCapacity.map((c, w) => c + hireHoursByWeek[w] / FF_NEW_HIRE_RATIO);

    const scheduledTurnaround = simulateDesignTurnaroundsUnclamped(fulfillmentQueue, designOutputByWeek, baseCapacity);
    const planTurnaround      = simulateDesignTurnaroundsUnclamped(fulfillmentQueue, designOutputByWeek, planCapacity);

    return { scheduledHours, plannedHours, hireHoursByWeek, scheduledTurnaround, planTurnaround };
  }, [ffWeeklyTotals, ffNewHireHours, fulfillmentQueue, designOutputByWeek]);

  function setFfNewHireHours(weekIso: string, hours: number) {
    const next = { ...ffNewHireHours };
    if (hours > 0) next[weekIso] = hours; else delete next[weekIso];
    onFfNewHireHoursChange(next);
  }

  function handleAddFfMember() {
    const id = `${location.toLowerCase()}-f-${Date.now()}`;
    onFfRosterChange({ ...ffRoster, [id]: { ratio: 1.0, rate: 0, name: 'New Member' } });
    onFfHoursChange({ ...ffHours, [id]: {} });
  }
  function handleRemoveFfMember(id: string) {
    // Soft-delete: mark as removed so they drop off the active roster, but
    // keep their roster entry and scheduledHours intact for historicals.
    const newRoster = { ...ffRoster };
    const existing = newRoster[id] ?? team.find(m => m.id === id) ?? { ratio: 1, rate: 0, name: '' };
    newRoster[id] = { ...existing, _removed: true };
    onFfRosterChange(newRoster);
  }
  function updateFfRosterName(id: string, name: string) {
    const existing = ffRoster[id] ?? { ratio: 1.0, rate: 0, name: 'New Member' };
    onFfRosterChange({ ...ffRoster, [id]: { ...existing, name } });
  }

  // Same idea as Design's resolveMgrTotalWeekHours: a day's fallback is that
  // day's already-resolved PRODUCTION hours, not a flat template.
  function resolveFfMgrTotalWeekHours(weekIdx: number, memberId: string, productionHrs: number): number {
    const weekIso = isoMonday(weekIdx);
    const weekKey = `${weekIso}-${memberId}`;
    const dailyOverrides = mgrTotalDailyHours[weekKey];
    if (dailyOverrides !== undefined) {
      let sum = 0;
      for (let day = 0; day < 7; day++) {
        const override = dailyOverrides[day];
        sum += override != null ? override
          : resolveDayHours(ffDailyHours, `${weekIso}-${memberId}`, day, ffRoster[memberId]?.standardWeeklyHours,
              { weekIso, startDate: ffRoster[memberId]?.startDate, endDate: ffRoster[memberId]?.endDate }).hours;
      }
      return sum;
    }
    return mgrTotalHours[memberId]?.[weekIso] ?? productionHrs;
  }
  function updateRoster(mi: number, field: 'ratio' | 'rate' | 'payType' | 'annualSalary' | 'role' | 'startDate' | 'endDate', val: number | string) {
    const id = team[mi]?.id;
    if (!id) return;
    const existing = ffRoster[id] ?? { ratio: team[mi].ratio, rate: team[mi].rate, name: team[mi].name, payType: 'hourly' as const, annualSalary: 0 };
    onFfRosterChange({ ...ffRoster, [id]: { ...existing, [field]: val } });
  }
  function updateFfTemplate(id: string, dayIdx: number, value: number) {
    const existing = ffRoster[id] ?? { ratio: 1.0, rate: 0, name: '' };
    const prevTemplate = existing.standardWeeklyHours ?? [0, 0, 0, 0, 0, 0, 0];
    const nextTemplate = prevTemplate.map((h, j) => j === dayIdx ? value : h);
    onFfRosterChange({ ...ffRoster, [id]: { ...existing, standardWeeklyHours: nextTemplate } });

    // Legacy per-week values (ffHours) predate the standard-schedule template
    // and outrank it in resolveWeekHours — nothing in the current UI writes
    // new ones, so any that remain on a future week are stale pre-template
    // leftovers silently shadowing whatever the template says. Release just
    // those (current week forward only, past weeks kept as historical
    // record) so a template edit actually takes effect. Any week the manager
    // has genuinely touched via "This Week" has a real ffDailyHours entry —
    // untouched here, so intentional day-level overrides never get wiped.
    const legacyForMember = ffHours[id];
    if (legacyForMember) {
      const nextLegacy = { ...legacyForMember };
      let changed = false;
      const currentWeekIso = isoMonday(0);
      for (let w = 0; w < WEEKS; w++) {
        const weekIso = isoMonday(w);
        if (weekIso < currentWeekIso) continue;
        if (nextLegacy[weekIso] === undefined) continue;
        if (ffDailyHours[`${weekIso}-${id}`]) continue;
        delete nextLegacy[weekIso];
        changed = true;
      }
      if (changed) onFfHoursChange({ ...ffHours, [id]: nextLegacy });
    }
  }
  // Clears every frozen day/week override for this member from the current
  // week forward (past weeks untouched) so they fall back to the template.
  function resetFfMemberToTemplate(id: string) {
    if (!window.confirm('Clear this person’s scheduled hours from this week forward and go back to following their standard schedule? Past weeks are not affected.')) return;
    const newDaily = { ...ffDailyHours };
    let changedDaily = false;
    const newWeekly = { ...ffHours };
    let changedWeekly = false;
    for (let w = 0; w < WEEKS; w++) {
      const weekIso = isoMonday(w);
      const dailyKey = `${weekIso}-${id}`;
      if (newDaily[dailyKey]) { delete newDaily[dailyKey]; changedDaily = true; }
      if (newWeekly[id]?.[weekIso] !== undefined) {
        newWeekly[id] = { ...newWeekly[id] };
        delete newWeekly[id][weekIso];
        changedWeekly = true;
      }
    }
    if (changedDaily) { setFfDailyHours(newDaily); onFfDailyHoursChange?.(newDaily); }
    if (changedWeekly) onFfHoursChange(newWeekly);
  }

  return (
    <div className="space-y-4">
      <div className="flex border-b border-slate-200">
        {(['thisweek', 'schedule', 'queue', 'historicals'] as const).filter(t => userRole !== 'viewer').map(t => (
          <button key={t} onClick={() => setFfTab(t)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              ffTab === t ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>{t === 'thisweek' ? 'This Week' : t === 'schedule' ? 'Weekly Schedule' : t === 'queue' ? 'Queue & Turnaround' : 'Historicals'}</button>
        ))}
      </div>

      {ffTab === 'thisweek' && (() => {
        const days = getWeekdays(ffThisWeekOffset);
        function getFFH(id: string, di: number) {
          const weekIso = isoMonday(ffThisWeekOffset);
          return resolveDayHours(ffDailyHours, `${weekIso}-${id}`, di, ffRoster[id]?.standardWeeklyHours,
            { weekIso, startDate: ffRoster[id]?.startDate, endDate: ffRoster[id]?.endDate }).hours;
        }
        function isFFHOverride(id: string, di: number) {
          const weekIso = isoMonday(ffThisWeekOffset);
          return resolveDayHours(ffDailyHours, `${weekIso}-${id}`, di, ffRoster[id]?.standardWeeklyHours,
            { weekIso, startDate: ffRoster[id]?.startDate, endDate: ffRoster[id]?.endDate }).isOverride;
        }
        function setFFH(id: string, di: number, val: number) {
          const weekIso = isoMonday(ffThisWeekOffset);
          const key = `${weekIso}-${id}`;
          const padded = [...baseDailyArray(ffDailyHours, key, ffHours[id]?.[weekIso], isoMonday(0))];
          padded[di] = val;
          const next = { ...ffDailyHours, [key]: padded };
          setFfDailyHours(next);
          onFfDailyHoursChange?.(next);
        }
        function getMgrTotalFFH(id: string, di: number) {
          const override = mgrTotalDailyHours[`${isoMonday(ffThisWeekOffset)}-${id}`]?.[di];
          return override != null ? override : getFFH(id, di);
        }
        function setMgrTotalFFH(id: string, di: number, val: number) {
          const key = `${isoMonday(ffThisWeekOffset)}-${id}`;
          const prev = mgrTotalDailyHours[key] ?? [null, null, null, null, null, null, null];
          const padded = Array.from({ length: 7 }, (_, j) => prev[j] ?? null);
          padded[di] = val;
          onMgrTotalDailyHoursChange({ ...mgrTotalDailyHours, [key]: padded });
        }
        function ffDailyCost(m: Omit<FfTeamMember, 'hours'> & { hours: unknown }, di: number) {
          const h = m.isManager ? getMgrTotalFFH(m.id, di) : getFFH(m.id, di);
          return m.payType === 'salary' ? m.annualSalary / 260 : h * m.rate;
        }
        const teamDailyOrders = (di: number) => team.reduce((s, m) => {
          const h = getFFH(m.id, di); return s + (m.ratio > 0 && h > 0 ? h / m.ratio : 0);
        }, 0);
        const teamDailyCost = (di: number) => team.reduce((s, m) => s + ffDailyCost(m, di), 0);
        const teamWeekOrders = days.reduce((s, _, di) => s + teamDailyOrders(di), 0);
        const ffHasRates = canViewCPO && team.some(m => m.rate > 0 || m.annualSalary > 0);
        return (
          <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
              <div>
                <h3 className="text-sm font-semibold text-slate-700">Hours per team member per day — {ffThisWeekOffset === 0 ? 'this week' : ffThisWeekOffset === 1 ? 'next week' : `week +${ffThisWeekOffset}`}</h3>
                <p className="text-xs text-slate-400 mt-0.5">{days[0]?.dateStr} – {days[4]?.dateStr} · Orders calculated from each member&apos;s ratio.</p>
              </div>
              <div className="flex items-center gap-2">
                {ffHasRates && <span className="text-xs text-slate-400 mr-2">CPO shown when rate is set</span>}
                <InputModeToggle mode={ffInputMode} onChange={setFfInputMode} unitLabel="Frames" />
                <button onClick={() => setFfThisWeekOffset(Math.max(0, ffThisWeekOffset - 1))} disabled={ffThisWeekOffset === 0} className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
                <button onClick={() => setFfThisWeekOffset(Math.min(maxFfThisWeekOffset, ffThisWeekOffset + 1))} disabled={ffThisWeekOffset >= maxFfThisWeekOffset} className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 min-w-[160px]">Team member</th>
                    {days.map((d, i) => (
                      <th key={i} className={`px-2 py-2 text-center font-medium min-w-[90px] whitespace-nowrap ${i === 0 ? 'bg-amber-50 text-amber-700' : 'text-slate-500'}`}>
                        {d.label}<br /><span className="font-normal text-[10px]">{d.dateStr}</span>
                      </th>
                    ))}
                    <th className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap">Week total</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((m, mi) => {
                    const weekOrders = days.reduce((s, _, di) => { const h = getFFH(m.id, di); return s + (m.ratio > 0 && h > 0 ? h / m.ratio : 0); }, 0);
                    const weekHrs = days.reduce((s, _, di) => s + (m.isManager ? getMgrTotalFFH(m.id, di) : getFFH(m.id, di)), 0);
                    const weekCost = days.reduce((s, _, di) => s + ffDailyCost(m, di), 0);
                    const weekCPO = weekOrders > 0 && weekCost > 0 ? weekCost / weekOrders : null;
                    return (
                      <tr key={m.id} className={`border-b border-slate-50 ${mi % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                        <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap">
                          <div className="font-medium text-slate-700">{m.name}</div>
                          <div className="text-slate-400">{m.ratio} h/ord</div>
                        </td>
                        {days.map((_, dayIdx) => {
                          const h = getFFH(m.id, dayIdx);
                          const isOverride = isFFHOverride(m.id, dayIdx);
                          const totalH = m.isManager ? getMgrTotalFFH(m.id, dayIdx) : h;
                          const orders = m.ratio > 0 && h > 0 ? h / m.ratio : 0;
                          const cost = ffDailyCost(m, dayIdx);
                          const cpo = !m.isManager && orders > 0 && cost > 0 ? cost / orders : null;
                          return (
                            <td key={dayIdx} className={`px-2 py-1.5 text-center ${dayIdx === 0 ? 'bg-amber-50/30' : ''}`}>
                              <input type="number"
                                value={ffInputMode === 'output' ? (orders ? round2(orders) : '') : (h || '')}
                                min="0" step={ffInputMode === 'output' ? '0.1' : '0.5'} placeholder="0"
                                title={isOverride ? 'Explicit override for this day' : 'Following the standard weekly schedule — edit to override just this day'}
                                onChange={e => {
                                  const raw = parseFloat(e.target.value) || 0;
                                  setFFH(m.id, dayIdx, ffInputMode === 'output' ? hoursFromOutput(raw, m.ratio) : raw);
                                }}
                                className={`w-14 border rounded px-1.5 py-1 text-center bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 ${
                                  isOverride ? 'border-slate-200 text-slate-700' : 'border-slate-100 text-slate-400 italic'
                                }`} />
                              {m.isManager && (
                                <input type="number" value={totalH || ''} min="0" step="0.5" placeholder="total h"
                                  title="Total hours (production + managerial)"
                                  onChange={e => setMgrTotalFFH(m.id, dayIdx, parseFloat(e.target.value) || 0)}
                                  className="w-14 mt-0.5 border border-violet-200 rounded px-1.5 py-0.5 text-center text-[10px] text-violet-600 bg-violet-50 focus:outline-none focus:ring-1 focus:ring-violet-300" />
                              )}
                              {ffInputMode === 'output'
                                ? (h > 0 && <div className="text-slate-400 mt-0.5">{round2(h)}h</div>)
                                : (orders > 0 && <div className="text-slate-400 mt-0.5">{round2(orders)} ord</div>)}
                              {ffHasRates && cpo !== null && <div className="text-amber-600 text-[10px]">{fmt$(cpo)}</div>}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-center">
                          <div className="font-medium text-amber-700">{Math.round(weekOrders * 100) / 100} ord</div>
                          <div className="text-slate-400 text-[10px]">{weekHrs}h</div>
                          {ffHasRates && !m.isManager && weekCPO !== null && <div className="text-amber-600 text-[10px]">{fmt$(weekCPO)}</div>}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                    <td className="sticky left-0 bg-slate-50 px-4 py-2 text-xs text-slate-600">Daily total</td>
                    {days.map((_, di) => {
                      const o = teamDailyOrders(di); const cc = teamDailyCost(di);
                      const cpo = o > 0 && cc > 0 ? cc / o : null;
                      const ffDayHours = team.reduce((s, m) => s + (ffDailyHours[`${isoMonday(ffThisWeekOffset)}-${m.id}`]?.[di] ?? 0), 0);
                      const ffDayRatio = o > 0 ? ffDayHours / o : null;
                      return (
                        <td key={di} className={`px-2 py-2 text-center ${di === 0 ? 'bg-amber-50/50' : ''}`}>
                          <div className="text-amber-700">{Math.round(o * 100) / 100} ord</div>
                          {ffDayRatio !== null && <div className="text-[10px] text-slate-500">{Math.round(ffDayRatio * 100) / 100} h/ord</div>}
                          {ffHasRates && cpo !== null && <div className="text-[10px] text-amber-600">{fmt$(cpo)}/ord</div>}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center font-semibold text-amber-700">{Math.round(teamWeekOrders * 100) / 100} ord</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {ffTab === 'schedule' && (
        <>
          <div>
            <button onClick={() => setShowRoster(r => !r)} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
              {showRoster ? '▲ Hide' : '▼ Edit'} fulfillment roster, ratios &amp; pay rates
            </button>
            {showRoster && (
              <div className="mt-3 bg-white border border-slate-100 rounded-xl p-5">
                <FfRosterEditor
                  team={team}
                  ffRoster={ffRoster}
                  deptLocation={location}
                  onUpdateName={updateFfRosterName}
                  onUpdateRoster={updateRoster}
                  onTemplateChange={updateFfTemplate}
                  onResetToTemplate={resetFfMemberToTemplate}
                  onRemove={handleRemoveFfMember}
                  employeeRates={employeeRates}
                  onRefreshRatio={async (id, name) => {
                    try {
                      const res = await fetch(`/api/actuals?location=${location}&type=team&weeks=100`);
                      const data = await res.json() as { teamActuals?: { department: string; week_of: string; member_name: string; actual_hours: number; actual_orders: number }[] };
                      const rows = (data.teamActuals ?? []).filter(r => r.department === 'fulfillment' && r.member_name === name).sort((a, b) => b.week_of.localeCompare(a.week_of)).slice(0, 4);
                      const h = rows.reduce((s, r) => s + r.actual_hours, 0);
                      const o = rows.reduce((s, r) => s + r.actual_orders, 0);
                      if (o > 0 && h > 0) updateRoster(team.findIndex(m => m.id === id), 'ratio', Math.round(h / o * 100) / 100);
                    } catch {}
                  }}
                  onReorder={(newOrder) => {
                    const newRoster = { ...ffRoster };
                    newOrder.forEach((id, i) => {
                      newRoster[id] = { ...(newRoster[id] ?? { ratio: 1, rate: 0, name: '' }), _order: i } as typeof newRoster[string];
                    });
                    onFfRosterChange(newRoster);
                  }}
                />
                <button onClick={handleAddFfMember}
                  className="mt-4 text-xs px-3 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 transition-colors">
                  + Add team member
                </button>
                <p className="mt-3 text-xs text-slate-400"><strong>Ratio:</strong> hours per order. e.g. 0.5 = 1 order per 0.5 hrs.</p>
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-wrap gap-2">
              <h3 className="text-sm font-semibold text-slate-700">Hours per team member per week</h3>
              <div className="flex items-center gap-2">
                <InputModeToggle mode={ffInputMode} onChange={setFfInputMode} unitLabel="Frames" />
                <button onClick={() => setWeekOffset(Math.max(0, weekOffset - WINDOW))} disabled={weekOffset === 0}
                  className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
                <span className="text-xs text-slate-400">{getWeekLabel(weekOffset)} – {getWeekLabel(weekOffset + WINDOW - 1)}</span>
                <button onClick={() => setWeekOffset(Math.min(WEEKS - WINDOW, weekOffset + WINDOW))} disabled={weekOffset + WINDOW >= WEEKS}
                  className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 min-w-[160px]">Team member</th>
                    {Array.from({ length: WINDOW }, (_, i) => i + weekOffset).filter(i => i < WEEKS).map(w => (
                      <th key={w} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[90px]">
                        {getWeekLabel(w)}{w === 0 && <span className="ml-1 text-[10px] bg-indigo-100 text-indigo-600 rounded px-1">now</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {team.map((m, mi) => (
                    <tr key={m.id} className={`border-b border-slate-50 ${mi % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                      <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap">
                        <div className="font-medium text-slate-700">{m.name}</div>
                        <div className="text-slate-400">{m.ratio} h/ord</div>
                        {m.payType === 'salary' && <div className="text-[10px] text-amber-600">salary</div>}
                      </td>
                      {Array.from({ length: WINDOW }, (_, i) => i + weekOffset).filter(i => i < WEEKS).map(w => {
                        const weekIso = isoMonday(w);
                        const prodH = resolveWeekHours({
                          dailyMap: ffDailyHours, weekKey: `${weekIso}-${m.id}`,
                          legacyWeeklyValue: ffHours[m.id]?.[weekIso],
                          standardWeeklyHours: ffRoster[m.id]?.standardWeeklyHours,
                          hardcodedDefault: m.defaultHrs,
                          employment: { weekIso, startDate: ffRoster[m.id]?.startDate, endDate: ffRoster[m.id]?.endDate },
                        });
                        const totalH = m.isManager ? resolveFfMgrTotalWeekHours(w, m.id, prodH) : prodH;
                        const o = m.ratio > 0 ? prodH / m.ratio : 0;
                        const cost = m.payType === 'salary' ? m.annualSalary / 52 : totalH * m.rate;
                        const cpo = !m.isManager && o > 0 && cost > 0 ? cost / o : null;
                        return (
                          <td key={w} className={`px-2 py-1.5 text-center ${w === 0 ? 'bg-indigo-50/30' : ''}`}>
                            <div className="text-slate-700 font-medium" title="Set on the Roster (standard schedule) or the This Week tab (one-off exceptions) — Weekly Schedule is a read-only view">
                              {ffInputMode === 'output' ? round2(o) : round2(prodH)}
                            </div>
                            {m.isManager && totalH !== prodH && (
                              <div className="text-[10px] text-violet-600">{round2(totalH)}h total</div>
                            )}
                            {ffInputMode === 'output'
                              ? (prodH > 0 && <div className="text-slate-400 mt-0.5">{round2(prodH)}h</div>)
                              : (o > 0 && <div className="text-slate-400 mt-0.5">{round2(o)} ord</div>)}
                            {cpo !== null && <div className="text-amber-600 text-[10px]">{fmt$(cpo)}</div>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                    <td className="sticky left-0 bg-slate-50 px-4 py-2 text-xs text-slate-600">Week total</td>
                    {Array.from({ length: WINDOW }, (_, i) => i + weekOffset).filter(i => i < WEEKS).map(w => {
                      const weekIso = isoMonday(w);
                      const prodHours = (m: typeof team[number]) => resolveWeekHours({
                        dailyMap: ffDailyHours, weekKey: `${weekIso}-${m.id}`,
                        legacyWeeklyValue: ffHours[m.id]?.[weekIso],
                        standardWeeklyHours: ffRoster[m.id]?.standardWeeklyHours,
                        hardcodedDefault: m.defaultHrs,
                        employment: { weekIso, startDate: ffRoster[m.id]?.startDate, endDate: ffRoster[m.id]?.endDate },
                      });
                      const c = team.reduce((s, m) => s + (m.ratio > 0 ? prodHours(m) / m.ratio : 0), 0);
                      const cost = team.reduce((s, m) => {
                        const prodH = prodHours(m);
                        const totalH = m.isManager ? resolveFfMgrTotalWeekHours(w, m.id, prodH) : prodH;
                        return s + (m.payType === 'salary' ? m.annualSalary / 52 : totalH * m.rate);
                      }, 0);
                      const cpo = c > 0 && cost > 0 ? cost / c : null;
                      return (
                        <td key={w} className={`px-2 py-2 text-center ${w === 0 ? 'bg-indigo-50/50' : ''}`}>
                          <div className="text-amber-700">{round2(c)} ord</div>
                          {cpo !== null && <div className="text-[10px] text-amber-600">{fmt$(cpo)}</div>}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-slate-400">Right-click any hours cell to apply that value to all 52 weeks for that team member.</p>
        </>
      )}

      {ffTab === 'queue' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-100 rounded-xl p-5">
            <div className="flex items-start justify-between gap-2 flex-wrap mb-1">
              <h2 className="text-sm font-semibold text-slate-700">Future turnaround — orders arriving from Design each week</h2>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Estimated weeks from an order leaving Design to shipping out of Fulfillment. Target is {FF_TARGET_WEEKS} weeks or less.
              Currently {fulfillmentQueue.toLocaleString()}{countsLoading ? '…' : ''} orders waiting in Fulfillment right now (live count).
              Add a hypothetical hire below to see how Planned turnaround responds, for that week and every week after.
            </p>
            {(() => {
              const maxWeeksScale = Math.max(
                ...ffHiringPlan.scheduledTurnaround.filter((t): t is number => t !== null),
                ...ffHiringPlan.planTurnaround.filter((t): t is number => t !== null),
                FF_TARGET_WEEKS,
              ) * 1.05;
              return (
                <div className="overflow-x-auto -mx-1">
                  <table className="min-w-full text-xs border-separate" style={{ borderSpacing: 0 }}>
                    <thead>
                      <tr className="text-slate-400">
                        <th className="text-left font-medium px-2 py-1.5 sticky left-0 bg-white whitespace-nowrap">Week</th>
                        <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">From Design</th>
                        <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">New hire</th>
                        <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">Fulfillment hours</th>
                        <th className="text-left font-medium px-2 py-1.5 min-w-[220px]">Turnaround</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ffHiringPlan.planTurnaround.map((total, w) => {
                        const schedTotal = ffHiringPlan.scheduledTurnaround[w];
                        const { bar, text, label } = fulfillmentTurnaroundColors(total);
                        const schedColors = fulfillmentTurnaroundColors(schedTotal);
                        const categoryOf = (l: string) => l.split('—')[1]?.trim() ?? l;
                        const weekIso = isoMonday(w);
                        const scheduledH = ffHiringPlan.scheduledHours[w];
                        const plannedH   = ffHiringPlan.plannedHours[w];
                        const hireCum    = ffHiringPlan.hireHoursByWeek[w];
                        return (
                          <tr key={w} className={`border-b border-slate-50 align-top ${w % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                            <td className="px-2 py-2 sticky left-0 bg-inherit whitespace-nowrap text-slate-500">
                              {getWeekLabel(w)}
                              {w === 0 && <span className="ml-1 text-[9px] bg-indigo-100 text-indigo-600 rounded px-1">now</span>}
                            </td>
                            <td className="px-2 py-2 whitespace-nowrap text-slate-600">
                              {round2(designOutputByWeek[w])} ord
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number" min="0" step="1" placeholder="0"
                                  value={ffNewHireHours[weekIso] ?? ''}
                                  onChange={e => setFfNewHireHours(weekIso, parseFloat(e.target.value) || 0)}
                                  className="w-14 border border-slate-200 rounded px-1.5 py-0.5 text-center text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-300"
                                  title="Hours/wk a hypothetical new hire starting this week would average"
                                />
                                <span className="text-[10px] text-slate-300">h/wk</span>
                              </div>
                              {hireCum > 0 && (
                                <div className="text-[10px] text-emerald-600 mt-0.5 whitespace-nowrap">+{Math.round(hireCum)}h/wk running</div>
                              )}
                            </td>
                            <td className="px-2 py-2 whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                <span className="text-slate-400 w-14 shrink-0">Scheduled</span>
                                <span className="text-slate-700 font-medium">{Math.round(scheduledH)}h</span>
                              </div>
                              <div className="flex items-center gap-1.5 mt-1">
                                <span className="text-emerald-600 w-14 shrink-0">Planned</span>
                                <span className="text-emerald-700 font-medium">{Math.round(plannedH)}h</span>
                              </div>
                            </td>
                            <td className="px-2 py-2">
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-slate-400 w-14 shrink-0">Scheduled</span>
                                  {schedTotal !== null ? (
                                    <>
                                      <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                                        <div className={`h-2 rounded-full ${schedColors.bar}`} style={{ width: `${Math.min(100, (schedTotal / maxWeeksScale) * 100)}%` }} />
                                      </div>
                                      <span className={`text-[10px] font-medium w-14 text-right shrink-0 ${schedColors.text}`}>{schedTotal}w</span>
                                    </>
                                  ) : (
                                    <span className="text-[10px] text-red-500 italic">52wk+</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-slate-400 w-14 shrink-0">Planned</span>
                                  {total !== null ? (
                                    <>
                                      <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                                        <div className={`h-2 rounded-full ${bar}`} style={{ width: `${Math.min(100, (total / maxWeeksScale) * 100)}%` }} />
                                      </div>
                                      <span className={`text-[10px] font-semibold w-14 text-right shrink-0 ${text}`}>{total}w</span>
                                    </>
                                  ) : (
                                    <span className="text-[10px] text-red-600 italic">52wk+</span>
                                  )}
                                </div>
                              </div>
                              {total !== null && (
                                <div className={`text-[10px] mt-0.5 ${text}`}>{categoryOf(label)}</div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
            <div className="flex gap-4 mt-4 pt-3 border-t border-slate-100 flex-wrap">
              <span className="text-[10px] text-slate-500">From Design: that week&apos;s actual design output if logged, else Design&apos;s own scheduled capacity for that week.</span>
              <span className="text-[10px] text-slate-500 border-l border-slate-200 pl-4">Fulfillment hours: Scheduled = the real Weekly Schedule. Planned = Scheduled + any new hire above.</span>
              <span className="flex items-center gap-1.5 text-[10px] text-slate-500 border-l border-slate-200 pl-4"><span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" /> ≤1 wk ideal</span>
              <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> ≤{FF_TARGET_WEEKS} wks at target</span>
              <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-red-600 inline-block" /> &gt;{FF_TARGET_WEEKS} wks over target</span>
            </div>
          </div>
        </div>
      )}

      {ffTab === 'historicals' && (
        <HistoricalsSection
          department="fulfillment"
          location={location}
          members={team.map(m => ({ id: m.id, name: m.name, payType: m.payType ?? 'hourly', hourlyRate: m.rate, annualSalary: m.annualSalary ?? 0, isManager: m.isManager, excludeFromCPO: (m as {excludeFromCPO?:boolean}).excludeFromCPO }))}
          ordersLabel="orders"
          excludeFromCPONames={['Zac Williams', 'Lauren Boyd']}

        />
      )}
    </div>
  );
}

// ─── Master roster data ───────────────────────────────────────────────────────
// All real staff per location with home dept and whether they are on-call only

interface StaffMember {
  id:       string;
  name:     string;
  homeDept: 'design' | 'preservation' | 'fulfillment' | 'resin';
  onCall:   boolean;
}

const UTAH_STAFF: StaffMember[] = [
  { id: 'ut-mgr', name: 'Jennika Merrill',       homeDept: 'design',       onCall: false },
  { id: 'ut-1',   name: 'Deanna Haug',         homeDept: 'design',       onCall: false },
  { id: 'ut-3',   name: 'Kathryn Sonntag',            homeDept: 'design',       onCall: false },
  { id: 'ut-4',   name: 'Mia Legas Boots',               homeDept: 'design',       onCall: false },
  { id: 'ut-5',   name: 'Sloane James',            homeDept: 'design',       onCall: false },
  { id: 'ut-6',   name: 'Audrey Windsor',            homeDept: 'design',       onCall: false },
  { id: 'ut-7',   name: 'Chloe Jensen',           homeDept: 'design',       onCall: false },
  { id: 'ut-p1',  name: 'Katelyn Wilson',          homeDept: 'preservation', onCall: false },
  { id: 'ut-p2',  name: 'Emma Dunakey',            homeDept: 'preservation', onCall: true  },
  { id: 'ut-f1',  name: 'Bella DePrima',        homeDept: 'fulfillment',  onCall: false },
  { id: 'ut-f2',  name: 'Warner Neuenschwander',   homeDept: 'fulfillment',  onCall: false },
  { id: 'ut-f3',  name: 'Owen Shaw',               homeDept: 'fulfillment',  onCall: false },
  { id: 'ut-f4',  name: 'Emma Van Dyke',            homeDept: 'fulfillment',  onCall: false },
  { id: 'resin-1', name: 'Preslee Peterson',       homeDept: 'resin',       onCall: false },
];

const GEORGIA_STAFF: StaffMember[] = [
  { id: 'ga-1',  name: 'Katherine Piper',  homeDept: 'design',       onCall: false },
  { id: 'ga-2',  name: 'Allanna Harlan',   homeDept: 'design',       onCall: false },
  { id: 'ga-3',  name: 'Erin Webb',        homeDept: 'design',       onCall: false },
  { id: 'ga-4',  name: 'Rachel Tucker',    homeDept: 'design',       onCall: false },
  { id: 'ga-p2', name: 'Celt Stewart',     homeDept: 'preservation', onCall: false },
  { id: 'ga-f1', name: 'Yann Jean-Louis',  homeDept: 'fulfillment',  onCall: false },
  { id: 'ga-f2', name: 'Nahid Knight',     homeDept: 'fulfillment',  onCall: false },
  { id: 'ga-f3', name: 'Shantel Phifer',   homeDept: 'fulfillment',  onCall: false },
];

const DEPT_COLOR: Record<string, string> = {
  design:       'bg-indigo-100 text-indigo-700',
  preservation: 'bg-green-100 text-green-700',
  fulfillment:  'bg-amber-100 text-amber-700',
  resin:        'bg-purple-100 text-purple-700',
};

// Returns next N weekdays (Mon-Fri) from today, optionally offset by weeks
function getWeekdays(weekOffset: number): { iso: string; label: string; dateStr: string }[] {
  const days: { iso: string; label: string; dateStr: string }[] = [];
  // Start from Monday of the offset week
  const today = new Date();
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + weekOffset * 7);
  monday.setHours(0,0,0,0);
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push({
      iso:     d.toISOString().split('T')[0],
      label:   d.toLocaleDateString('en-US', { weekday: 'short' }),
      dateStr: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    });
  }
  return days;
}

// ─── MasterScheduleSection ────────────────────────────────────────────────────

function MasterScheduleSection({ location, masterAvailability, onAvailabilityChange,
  designHours, designSchedule, presHours, ffHours, resinHours, designRoster, presRoster, ffRoster, ffDailyHours, presDailyHours, resinRoster, resinDailyHours }: {
  location:             'Utah' | 'Georgia';
  masterAvailability:   Record<string, { defaultHours: number; overrides: Record<string, number> }>;
  onAvailabilityChange: (a: Record<string, { defaultHours: number; overrides: Record<string, number> }>) => void;
  designHours:          Record<string, Record<string, number>>;
  designSchedule:       WeekSchedule[];
  presHours:            Record<string, Record<string, number>>;
  ffHours:              Record<string, Record<string, number>>;
  resinHours:           Record<string, Record<string, number>>;
  designRoster:         Record<string, { ratio: number; name: string }>;
  presRoster:           Record<string, { ratio: number; name: string; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }>;
  ffRoster:             Record<string, { ratio: number; name: string; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }>;
  ffDailyHours:         DailyHoursMap;
  presDailyHours:       DailyHoursMap;
  resinRoster:          ResinMember[];
  resinDailyHours:      DailyHoursMap;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const staff = location === 'Utah' ? UTAH_STAFF : GEORGIA_STAFF;
  const days   = getWeekdays(weekOffset);

  // Week index for design/ff (weekly schedules)
  const weekIdx = weekOffset;

  // ── Weekly totals per person ──────────────────────────────────────────────
  // designSchedule is already merged (persisted + defaults) — use it directly
  function getWeeklyScheduled(person: StaffMember): {
    design: number; preservation: number; fulfillment: number; resin: number; total: number;
  } {
    // Design: read from the already-merged schedule array
    const dHrs = designSchedule[weekIdx]?.[person.id] ?? 0;
    // Preservation: This Week overrides -> standard template -> legacy weekly value
    const weekIso = isoMonday(weekIdx);
    const pMember = presRoster[person.id];
    const pHrs = resolveWeekHours({
      dailyMap: presDailyHours, weekKey: `${weekIso}-${person.id}`,
      legacyWeeklyValue: presHours[person.id]?.[weekIso],
      standardWeeklyHours: pMember?.standardWeeklyHours,
      employment: { weekIso, startDate: pMember?.startDate, endDate: pMember?.endDate },
    });
    const fMember = ffRoster[person.id];
    const fHrs = resolveWeekHours({
      dailyMap: ffDailyHours, weekKey: `${weekIso}-${person.id}`,
      legacyWeeklyValue: ffHours[person.id]?.[weekIso],
      standardWeeklyHours: fMember?.standardWeeklyHours,
      employment: { weekIso, startDate: fMember?.startDate, endDate: fMember?.endDate },
    });
    // Resin: This Week overrides -> standard template -> legacy weekly value
    // (stored week-of-first, opposite nesting from design/ff)
    const rMember = resinRoster.find(m => m.id === person.id);
    const rHrs = resolveWeekHours({
      dailyMap: resinDailyHours, weekKey: `${weekIso}-${person.id}`,
      legacyWeeklyValue: resinHours[weekIso]?.[person.id],
      standardWeeklyHours: rMember?.standardWeeklyHours,
      employment: { weekIso, startDate: rMember?.startDate, endDate: rMember?.endDate },
    });
    return { design: dHrs, preservation: pHrs, fulfillment: fHrs, resin: rHrs, total: dHrs + pHrs + fHrs + rHrs };
  }

  // Weekly available = defaultHours × 5, overridable per week
  function getWeeklyAvail(person: StaffMember): number {
    const stored = masterAvailability[person.id];
    const mondayIso = days[0]?.iso ?? '';
    if (stored?.overrides?.[mondayIso] !== undefined) return stored.overrides[mondayIso];
    return (stored?.defaultHours ?? 8) * 5;
  }

  // Daily available for a specific day (used for preservation which is daily)
  function getDailyAvail(person: StaffMember, iso: string): number {
    const stored = masterAvailability[person.id];
    if (stored?.overrides?.[iso] !== undefined) return stored.overrides[iso];
    return stored?.defaultHours ?? 8;
  }

  function setDefault(personId: string, hours: number) {
    const existing = masterAvailability[personId] ?? { defaultHours: 8, overrides: {} };
    onAvailabilityChange({ ...masterAvailability, [personId]: { ...existing, defaultHours: hours } });
  }

  // Override for a specific day (pres team) or week Monday (design/ff)
  function setOverride(personId: string, iso: string, hours: number) {
    const existing = masterAvailability[personId] ?? { defaultHours: 8, overrides: {} };
    onAvailabilityChange({ ...masterAvailability, [personId]: { ...existing, overrides: { ...existing.overrides, [iso]: hours } } });
  }

  const weekLabel = weekOffset === 0 ? 'This week'
    : weekOffset === 1 ? 'Next week'
    : 'Week after next';

  // Group staff by dept
  const grouped = [
    { dept: 'design',       label: 'Design',      members: staff.filter(s => s.homeDept === 'design') },
    { dept: 'preservation', label: 'Preservation', members: staff.filter(s => s.homeDept === 'preservation') },
    { dept: 'fulfillment',  label: 'Fulfillment',  members: staff.filter(s => s.homeDept === 'fulfillment') },
  ] as const;

  const mondayIso = days[0]?.iso ?? '';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">{location} master schedule</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Weekly availability vs scheduled hours. Design, fulfillment &amp; resin show weekly totals. Preservation shows daily.
            <span className="ml-2 text-red-500 font-medium">Red ⚠ = over-scheduled</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setWeekOffset(Math.max(0, weekOffset - 1))} disabled={weekOffset === 0}
            className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
          <span className="text-xs font-medium text-slate-600 min-w-[100px] text-center">
            {weekLabel} · {days[0]?.dateStr} – {days[4]?.dateStr}
          </span>
          <button onClick={() => setWeekOffset(Math.min(4, weekOffset + 1))} disabled={weekOffset >= 4}
            className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-3 flex-wrap">
        {(['design','preservation','fulfillment','resin'] as const).map(d => (
          <span key={d} className={`text-xs rounded px-2 py-0.5 ${DEPT_COLOR[d]}`}>{d.charAt(0).toUpperCase()+d.slice(1)}</span>
        ))}
        <span className="text-xs bg-slate-100 text-slate-500 rounded px-2 py-0.5">On call</span>
        <span className="text-xs bg-red-100 text-red-700 rounded px-2 py-0.5">⚠ Over-scheduled</span>
      </div>

      {/* ── DESIGN + FULFILLMENT + RESIN staff — weekly view ─────────────────── */}
      {(['design','fulfillment','resin'] as const).map(deptKey => {
        const deptMembers = staff.filter(s => s.homeDept === deptKey);
        if (deptMembers.length === 0) return null;
        return (
          <div key={deptKey} className="bg-white border border-slate-100 rounded-xl overflow-hidden">
            <div className={`px-5 py-2.5 border-b border-slate-100 text-xs font-semibold uppercase tracking-wide ${DEPT_COLOR[deptKey].split(' ')[1]}`}>
              {deptKey.charAt(0).toUpperCase()+deptKey.slice(1)} — weekly view ({days[0]?.dateStr} – {days[4]?.dateStr})
            </div>
            <table className="min-w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="px-4 py-2 text-left font-medium text-slate-500 min-w-[160px]">Team member</th>
                  <th className="px-3 py-2 text-center font-medium text-slate-500">Default<br/>hrs/day</th>
                  <th className="px-3 py-2 text-center font-medium text-slate-500">Available<br/>this week</th>
                  <th className="px-3 py-2 text-center font-medium text-slate-500 text-indigo-600">Design<br/>hrs</th>
                  <th className="px-3 py-2 text-center font-medium text-green-700">Pres<br/>hrs</th>
                  <th className="px-3 py-2 text-center font-medium text-amber-700">FF<br/>hrs</th>
                  <th className="px-3 py-2 text-center font-medium text-purple-700">Resin<br/>hrs</th>
                  <th className="px-3 py-2 text-center font-medium text-slate-500">Total<br/>scheduled</th>
                  <th className="px-3 py-2 text-center font-medium text-slate-500">Remaining<br/>for flex</th>
                </tr>
              </thead>
              <tbody>
                {deptMembers.map((person, pi) => {
                  const sched    = getWeeklyScheduled(person);
                  const avail    = getWeeklyAvail(person);
                  const remain   = avail - sched.total;
                  const over     = sched.total > avail && sched.total > 0;
                  const defaultH = masterAvailability[person.id]?.defaultHours ?? 8;
                  const weekOverride = masterAvailability[person.id]?.overrides?.[mondayIso];
                  return (
                    <tr key={person.id} className={`border-b border-slate-50 ${pi % 2 === 0 ? '' : 'bg-slate-50/30'} ${over ? 'bg-red-50' : ''}`}>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <div className="font-medium text-slate-700">{person.name}</div>
                        {person.onCall && <span className="text-[10px] bg-slate-100 text-slate-500 rounded px-1 py-px">on call</span>}
                      </td>
                      {/* Default hours/day */}
                      <td className="px-3 py-2 text-center">
                        <input type="number" value={defaultH || ''} min="0" max="12" placeholder="8"
                          onChange={e => setDefault(person.id, parseFloat(e.target.value) || 0)}
                          className="w-12 border border-slate-200 rounded px-1.5 py-1 text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                      </td>
                      {/* Available this week (default×5 or week override) */}
                      <td className="px-3 py-2 text-center">
                        <input type="number" value={weekOverride !== undefined ? weekOverride : avail} min="0" max="60" placeholder={String(defaultH * 5)}
                          onChange={e => setOverride(person.id, mondayIso, parseFloat(e.target.value) || 0)}
                          className={`w-14 border rounded px-1.5 py-1 text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 ${weekOverride !== undefined ? 'border-indigo-300 text-indigo-700' : 'border-slate-200'}`}
                          title="Total available hours this week (click to override)" />
                      </td>
                      <td className="px-3 py-2 text-center font-medium text-indigo-700">{sched.design || '—'}</td>
                      <td className="px-3 py-2 text-center font-medium text-green-700">{sched.preservation || '—'}</td>
                      <td className="px-3 py-2 text-center font-medium text-amber-700">{sched.fulfillment || '—'}</td>
                      <td className="px-3 py-2 text-center font-medium text-purple-700">{sched.resin || '—'}</td>
                      <td className="px-3 py-2 text-center font-semibold text-slate-700">{sched.total || '—'}</td>
                      <td className={`px-3 py-2 text-center font-semibold ${over ? 'text-red-600' : remain > 0 ? 'text-green-700' : 'text-slate-400'}`}>
                        {over ? `⚠ ${Math.abs(remain)}h over` : remain > 0 ? `${remain}h free` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      {/* ── PRESERVATION staff — daily view ──────────────────────────────────── */}
      {(() => {
        const presMembers = staff.filter(s => s.homeDept === 'preservation');
        if (presMembers.length === 0) return null;
        return (
          <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
            <div className="px-5 py-2.5 border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-green-700">
              Preservation — daily view
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 min-w-[160px]">Team member</th>
                    <th className="px-3 py-2 text-center font-medium text-slate-500">Default<br/>hrs/day</th>
                    {days.map(d => (
                      <th key={d.iso} className="px-2 py-2 text-center font-medium text-slate-500 min-w-[90px]">
                        <div>{d.label}</div>
                        <div className="font-normal text-[10px]">{d.dateStr}</div>
                      </th>
                    ))}
                    <th className="px-3 py-2 text-center font-medium text-slate-500">Week<br/>remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {presMembers.map((person, pi) => {
                    const defaultH = masterAvailability[person.id]?.defaultHours ?? 8;
                    const weekSched = getWeeklyScheduled(person);
                    const weekAvail = defaultH * 5;
                    const weekRemain = weekAvail - weekSched.total;
                    const weekOver = weekSched.total > weekAvail && weekSched.total > 0;
                    return (
                      <tr key={person.id} className={`border-b border-slate-50 ${pi % 2 === 0 ? '' : 'bg-slate-50/30'}`}>
                        <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap">
                          <div className="font-medium text-slate-700">{person.name}</div>
                          {person.onCall && <span className="text-[10px] bg-slate-100 text-slate-500 rounded px-1 py-px">on call</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input type="number" value={defaultH || ''} min="0" max="12" placeholder="8"
                            onChange={e => setDefault(person.id, parseFloat(e.target.value) || 0)}
                            className="w-12 border border-slate-200 rounded px-1.5 py-1 text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                        </td>
                        {days.map((d, di) => {
                          const avail   = getDailyAvail(person, d.iso);
                          const presHrs = presHours[person.id]?.[di] ?? 0;
                          const over    = presHrs > avail && presHrs > 0;
                          const remain  = avail - presHrs;
                          const isOverridden = masterAvailability[person.id]?.overrides?.[d.iso] !== undefined;
                          return (
                            <td key={d.iso} className={`px-2 py-1.5 text-center ${over ? 'bg-red-50' : ''}`}>
                              <div className="flex items-center justify-center gap-0.5 mb-0.5">
                                <input type="number" value={avail || ''} min="0" max="12" placeholder={String(defaultH)}
                                  onChange={e => setOverride(person.id, d.iso, parseFloat(e.target.value) || 0)}
                                  className={`w-10 border rounded px-1 py-0.5 text-center text-[11px] bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 ${isOverridden ? 'border-indigo-300 text-indigo-700' : 'border-slate-200 text-slate-500'}`}
                                  title="Available hours this day" />
                                <span className="text-[10px] text-slate-300">av</span>
                              </div>
                              {presHrs > 0 && <div className="text-[10px] text-green-700 font-medium">{presHrs}h pres</div>}
                              {over ? (
                                <div className="text-[10px] text-red-600 font-semibold">⚠ +{presHrs - avail}h</div>
                              ) : remain > 0 ? (
                                <div className="text-[10px] text-slate-400">{remain}h free</div>
                              ) : null}
                            </td>
                          );
                        })}
                        {/* Week remaining summary */}
                        <td className={`px-3 py-2 text-center font-semibold ${weekOver ? 'text-red-600' : weekRemain > 0 ? 'text-green-700' : 'text-slate-400'}`}>
                          {weekOver ? `⚠ ${Math.abs(weekRemain)}h over` : weekRemain > 0 ? `${weekRemain}h free` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {(['design','preservation','fulfillment'] as const).map(d => {
          const deptStaff = staff.filter(s => s.homeDept === d && !s.onCall);
          const totalAvail = deptStaff.reduce((sum, p) => {
            const def = masterAvailability[p.id]?.defaultHours ?? 8;
            const mondayOverride = masterAvailability[p.id]?.overrides?.[mondayIso];
            return sum + (mondayOverride !== undefined ? mondayOverride : def * 5);
          }, 0);
          const totalSched = deptStaff.reduce((sum, p) => {
            const s = getWeeklyScheduled(p);
            return sum + s.total;
          }, 0);
          const pct = totalAvail > 0 ? Math.round(totalSched / totalAvail * 100) : 0;
          return (
            <div key={d} className="bg-white border border-slate-100 rounded-xl p-4">
              <p className={`text-xs font-semibold uppercase tracking-wide mb-2 ${DEPT_COLOR[d].split(' ')[1]}`}>
                {d.charAt(0).toUpperCase()+d.slice(1)}
              </p>
              <div className="flex items-end gap-1 mb-1">
                <span className="text-xl font-semibold text-slate-900">{totalSched}</span>
                <span className="text-xs text-slate-400 mb-0.5">/ {totalAvail} hrs this week</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                <div className={`h-1.5 rounded-full ${pct > 100 ? 'bg-red-500' : pct > 80 ? 'bg-green-500' : 'bg-slate-300'}`}
                  style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <p className="text-xs text-slate-400 mt-1">{pct}% utilized · {Math.max(0, totalAvail - totalSched)}h free for flex</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Monthly Ratio/CPO for one department: month-to-date actual vs. this month's
// Expected and Goal targets — all three pulled from useKpiMetrics, the exact
// same hook and /api/kpis formulas the All KPIs tab uses, so this card can
// never drift out of sync with it.
function DeptKPIBar({ dept, location, kpiState, showCPO }: {
  dept: KpiDept;
  location: KpiLocation;
  kpiState: KpiState;
  showCPO: boolean;
}) {
  if (kpiState.loading) return null;
  const mtdWindow = getWindowsByType(kpiState.windows, 'mtd')[0];
  const actual   = mtdWindow ? selectDept(selectLocation(mtdWindow, location), dept) : null;
  const expectedPeriod = selectEstimated(kpiState.estimated?.current, location, 'expected');
  const goalPeriod     = selectEstimated(kpiState.estimated?.current, location, 'goal');
  const expected = expectedPeriod ? selectDept(expectedPeriod, dept) : null;
  const goal     = goalPeriod ? selectDept(goalPeriod, dept) : null;

  const ratioColor = actual?.ratio != null && goal?.ratio != null
    ? actual.ratio <= goal.ratio ? 'text-green-600' : 'text-red-500'
    : 'text-slate-800';

  const columns: { label: string; d: typeof actual; labelColor: string; valueColor: string }[] = [
    { label: 'Month to date',  d: actual,   labelColor: 'text-indigo-400', valueColor: ratioColor },
    { label: 'Expected',       d: expected, labelColor: 'text-amber-500',  valueColor: 'text-slate-700' },
    { label: 'Goal',           d: goal,     labelColor: 'text-green-500',  valueColor: 'text-green-700' },
  ];

  return (
    <div className="bg-white border border-slate-100 rounded-xl px-5 py-3 flex items-center gap-0 flex-wrap gap-y-3">
      <div className="pr-4 mr-2 border-r border-slate-200 shrink-0">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{DEPT_LABELS[dept]} · {location}</p>
        <p className="text-[10px] text-slate-400">Monthly KPIs</p>
      </div>
      {columns.map(({ label, d, labelColor, valueColor }) => (
        <div key={label} className="flex flex-col gap-0.5 px-4 border-r border-slate-100 last:border-0">
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${labelColor}`}>{label}</span>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[10px] text-slate-400 w-8">Ratio</span>
              <span className={`text-sm font-semibold ${valueColor}`}>{fmtRatio(d?.ratio ?? null)}</span>
            </div>
            {showCPO && (
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] text-slate-400 w-8">CPO</span>
                <span className="text-sm font-semibold text-slate-800">{fmtCPO(d?.cpo ?? null)}</span>
              </div>
            )}
            {label === 'Month to date' && d && d.production > 0 && (
              <span className="text-[10px] text-slate-400">{fmtUnits(d.production)} {DEPT_PRODUCTION_UNIT[dept]}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Props from DashboardClient ────────────────────────────────────────────────

interface SchedulePageProps {
  utahDesignable?:    number;
  georgiaDesignable?: number;
  utahPreservation?:  number;
  georgiaPreservation?: number;
  utahFulfillment?:   number;
  georgiaFulfillment?: number;
  countsLoading?:     boolean;
  canEditUtah?:       boolean;
  canEditGeorgia?:    boolean;
  canViewCPO?:        boolean;
  userLocation?:      string | null;
  userDepartment?:    string | null;
  userRole?:          string;
}

// ─── Main SchedulePage ─────────────────────────────────────────────────────────

export function SchedulePage({
  utahDesignable    = 0,
  georgiaDesignable = 0,
  utahPreservation  = 0,
  georgiaPreservation = 0,
  utahFulfillment   = 0,
  georgiaFulfillment = 0,
  countsLoading     = false,
  canEditUtah       = false,
  canEditGeorgia    = false,
  canViewCPO        = true,
  userLocation      = null,
  userDepartment    = null,
  userRole          = 'admin',
}: SchedulePageProps) {

  const defaultLocation = (userLocation === 'Georgia' ? 'Georgia' : 'Utah') as 'Utah' | 'Georgia';
  const [location, setLocation] = useState<'Utah' | 'Georgia'>(defaultLocation);
  // Permission derived from current location
  const canEditCurrent = location === 'Utah' ? canEditUtah : canEditGeorgia;
  const defaultDept = (userDepartment as 'design' | 'preservation' | 'fulfillment' | null) ?? 'design';
  const [dept, setDept] = useState<'design' | 'preservation' | 'fulfillment' | 'master' | 'payroll' | 'resin'>(defaultDept);

  // ── Supabase-persisted settings ───────────────────────────────────────────────
  const { settings, loading: settingsLoading, saveState, update } = useScheduleSettings(location);
  const { holidays: paidHolidays, addHoliday, removeHoliday } = usePaidHolidays();
  const [pendingHolidayDate, setPendingHolidayDate] = useState('');
  // Employee rates from Rippling — used to fill zero rates for flex members
  const [employeeRates, setEmployeeRates] = useState<Record<string, { hourlyRate: number; annualSalary: number; payType: 'hourly'|'salary' }>>({});
  useEffect(() => {
    fetch(`/api/admin/employees-upload?location=${location}`)
      .then(r => r.json())
      .then((d: { employees?: { full_name: string; pay_type: string; hourly_rate: number; annual_salary: number }[] }) => {
        const map: Record<string, { hourlyRate: number; annualSalary: number; payType: 'hourly'|'salary' }> = {};
        (d.employees ?? []).forEach(e => {
          const entry = {
            hourlyRate:   e.hourly_rate > 0 ? e.hourly_rate : (e.annual_salary > 0 ? e.annual_salary / 2080 : 0),
            annualSalary: e.annual_salary ?? 0,
            payType:      (e.pay_type === 'salary' ? 'salary' : 'hourly') as 'hourly'|'salary',
          };
          // Index by full name, lowercase full name, and lowercase first name for flex member lookups
          map[e.full_name] = entry;
          map[e.full_name.toLowerCase()] = entry;
          const firstName = e.full_name.split(' ')[0].toLowerCase();
          if (!map[firstName]) map[firstName] = entry;
        });
        setEmployeeRates(map);
      })
      .catch(() => {});
  }, [location]); // eslint-disable-line react-hooks/exhaustive-deps


  // Derive designers and schedule from persisted settings + defaults
  const defaultDesigners = location === 'Utah' ? DEFAULT_UTAH_DESIGNERS : DEFAULT_GEORGIA_DESIGNERS;
  const defaultSchedule  = location === 'Utah' ? buildDefaultUtahSchedule() : buildDefaultGeorgiaSchedule();

  // Merge persisted roster over defaults — includes custom added designers.
  // `includeRemoved: true` returns everyone who's ever been on the roster
  // (including soft-deleted members) — used only for historicals, so past
  // scheduled-hours/goal data doesn't vanish when someone leaves.
  const buildDesigners = (includeRemoved: boolean): Designer[] => {
    const base = defaultDesigners
      .filter(d => includeRemoved || !settings.designRoster[d.id]?._removed)
      .map(d => {
        const persisted = settings.designRoster[d.id];
        if (!persisted) return d;
        const rateFromRippling = employeeRates[persisted.name ?? d.name]?.hourlyRate ?? 0;
        return { ...d, name: persisted.name ?? d.name, ratio: persisted.ratio, payType: persisted.payType, hourlyRate: persisted.hourlyRate > 0 ? persisted.hourlyRate : rateFromRippling, annualSalary: persisted.annualSalary };
      });
    const defaultIds = new Set(defaultDesigners.map(d => d.id));
    Object.entries(settings.designRoster).forEach(([id, r]) => {
      if (!defaultIds.has(id) && (includeRemoved || !r._removed)) {
        base.push({ id, name: r.name ?? 'New Designer', ratio: r.ratio ?? 1.5, payType: r.payType ?? 'hourly', hourlyRate: r.hourlyRate ?? 0, annualSalary: r.annualSalary ?? 0 });
      }
    });
    return base;
  };
  const designers: Designer[] = buildDesigners(false);

  // "This Week" daily overrides — declared here (rather than lower with the
  // rest of Design's local UI state) because `schedule` below now needs to
  // resolve through it. See src/lib/scheduleResolution.ts.
  const [designDailyHours, setDesignDailyHours] = useState<DailyHoursMap>(settings.designDailyHours ?? {});
  useEffect(() => { if (settings.designDailyHours && Object.keys(settings.designDailyHours).length > 0) setDesignDailyHours(settings.designDailyHours); }, [JSON.stringify(settings.designDailyHours)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Weekly Schedule is a read-only view derived from "This Week": explicit
  // daily overrides first, then the designer's standard weekly template, then
  // any legacy pre-cutover weekly value already saved directly here, then the
  // hardcoded onboarding/offboarding ramp in defaultSchedule.
  const schedule: WeekSchedule[] = Array.from({ length: WEEKS }, (_, w) => {
    const weekObj: WeekSchedule = {};
    const weekKey = isoMonday(w);
    designers.forEach(d => {
      weekObj[d.id] = resolveWeekHours({
        dailyMap: designDailyHours,
        weekKey: `${weekKey}-${d.id}`,
        legacyWeeklyValue: settings.designHours[d.id]?.[weekKey],
        standardWeeklyHours: settings.designRoster[d.id]?.standardWeeklyHours,
        hardcodedDefault: defaultSchedule[w]?.[d.id] ?? 0,
        employment: { weekIso: weekKey, startDate: settings.designRoster[d.id]?.startDate, endDate: settings.designRoster[d.id]?.endDate },
      });
    });
    return weekObj;
  });

  // Preservation actuals from Supabase
  const [presActuals, setPresActuals] = useState<Record<string, number>>({});
  const [presActualsLoading, setPresActualsLoading] = useState(false);

  useEffect(() => {
    setPresActualsLoading(true);
    fetch(`/api/actuals?location=${location}&type=preservation&weeks=52`)
      .then(r => r.json())
      .then((d: { preservationActuals?: { week_of: string; received: number }[] }) => {
        const map: Record<string, number> = {};
        (d.preservationActuals ?? []).forEach(row => { map[row.week_of] = row.received; });
        setPresActuals(map);
      })
      .catch(() => {})
      .finally(() => setPresActualsLoading(false));
  }, [location]);

  // Team actuals from Supabase
  const [teamActuals, setTeamActuals] = useState<{
    department: string; week_of: string; member_name: string; actual_hours: number; actual_orders: number;
  }[]>([]);

  useEffect(() => {
    fetch(`/api/actuals?location=${location}&type=team&weeks=52`)
      .then(r => r.json())
      .then((d: { teamActuals?: typeof teamActuals }) => { setTeamActuals(d.teamActuals ?? []); })
      .catch(() => {});
  }, [location]);

  // Design delivery promises — "weeks until designed" locked in for clients,
  // see the "Send biweekly bloom update" button on the Queue & Turnaround tab.
  // Keyed by intake week.
  const [designPromises, setDesignPromises] = useState<Record<string, {
    promisedByDate: string; promisedWeeks: number; lastConfirmedWeeks: number; lastConfirmedAt: string;
  }>>({});
  const [bloomModalOpen, setBloomModalOpen] = useState(false);
  const [bloomHistoryOpen, setBloomHistoryOpen] = useState(false);
  const [bloomHistory, setBloomHistory] = useState<{ id: number; sent_at: string; rows: BloomUpdateRow[] }[]>([]);
  const [bloomHistoryLoading, setBloomHistoryLoading] = useState(false);

  function loadDesignPromises() {
    fetch(`/api/design-promises?location=${location}`)
      .then(r => r.json())
      .then((d: { promises?: { week_of: string; promised_by_date: string; promised_weeks: number; last_confirmed_weeks: number; last_confirmed_at: string }[] }) => {
        const map: Record<string, { promisedByDate: string; promisedWeeks: number; lastConfirmedWeeks: number; lastConfirmedAt: string }> = {};
        (d.promises ?? []).forEach(row => {
          map[row.week_of] = {
            promisedByDate:    row.promised_by_date,
            promisedWeeks:     row.promised_weeks,
            lastConfirmedWeeks: row.last_confirmed_weeks,
            lastConfirmedAt:   row.last_confirmed_at,
          };
        });
        setDesignPromises(map);
      })
      .catch(() => {});
  }

  useEffect(() => { loadDesignPromises(); }, [location]); // eslint-disable-line react-hooks/exhaustive-deps

  function loadBloomHistory() {
    setBloomHistoryLoading(true);
    fetch(`/api/bloom-updates?location=${location}`)
      .then(r => r.json())
      .then((d: { updates?: { id: number; sent_at: string; rows: BloomUpdateRow[] }[] }) => {
        setBloomHistory(d.updates ?? []);
      })
      .catch(() => {})
      .finally(() => setBloomHistoryLoading(false));
  }

  const weeklyEstimates = settings.weeklyEstimates;
  const weeklyMultipliers = settings.weeklyMultipliers ?? {};

  // Same hook/endpoint the All KPIs tab uses — the per-department Monthly KPI
  // bars read from this so the two views can never disagree on formulas
  // (see /api/kpis for the canonical math).
  const kpiMetrics = useKpiMetrics();

  const hasAnyRates = canViewCPO && [...designers, ...(location === 'Utah' ? UTAH_PRESERVATION_TEAM : GEORGIA_PRESERVATION_TEAM), ...(location === 'Utah' ? UTAH_FULFILLMENT_TEAM : GEORGIA_FULFILLMENT_TEAM)].some(m => {
    const anyM = m as {rate?: number; hourlyRate?: number; annualSalary?: number; payType?: string};
    return (anyM.rate ?? anyM.hourlyRate ?? 0) > 0 || (anyM.annualSalary ?? 0) > 0;
  });
  function setWeeklyEstimate(weekOf: string, val: number) {
    const existing = weeklyEstimates[weekOf] ?? { ut: 0, ga: 0 };
    const updated = location === 'Utah'
      ? { ...existing, ut: val }
      : { ...existing, ga: val };
    update('weeklyEstimates', { ...weeklyEstimates, [weekOf]: updated });
  }

  function setWeeklyMultiplier(weekOf: string, val: number) {
    const existing = weeklyMultipliers[weekOf] ?? { ut: DEFAULT_INTAKE_MULTIPLIER, ga: DEFAULT_INTAKE_MULTIPLIER };
    const updated = location === 'Utah'
      ? { ...existing, ut: val }
      : { ...existing, ga: val };
    update('weeklyMultipliers', { ...weeklyMultipliers, [weekOf]: updated });
  }

  const avgIntake = settings.avgIntake;
  function setAvgIntake(v: number) { update('avgIntake', v); }

  const [showRoster,   setShowRoster]  = useState(false);
  const [weekOffset,   setWeekOffset]  = useState(0);
  const [showCPO,      setShowCPO]     = useState(true);
  const [designInputMode, setDesignInputMode] = useState<InputMode>('hours');
  const [queueUnit, setQueueUnit] = useState<InputMode>('hours');
  const [activeTab,    setActiveTab]   = useState<'thisweek' | 'schedule' | 'monthly' | 'queue' | 'historicals'>('thisweek');
  const [showDoneCohorts, setShowDoneCohorts] = useState(false);
  const [designThisWeekOffset, setDesignThisWeekOffset] = useState(0);
  // "This Week" needs to reach as far out as "Weekly Schedule" does — now that
  // Weekly Schedule is read-only, far-future one-off exceptions can only be
  // entered here.
  const maxDesignThisWeekOffset = WEEKS - 1;
  const [presDailyHours, setPresDailyHours] = useState<DailyHoursMap>(settings.presDailyHours ?? {});
  const [presCheckHours, setPresCheckHours] = useState<DailyHoursMap>(settings.presCheckHours ?? {});
  useEffect(() => { if (settings.presDailyHours && Object.keys(settings.presDailyHours).length > 0) setPresDailyHours(settings.presDailyHours); }, [JSON.stringify(settings.presDailyHours)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (settings.presCheckHours && Object.keys(settings.presCheckHours).length > 0) setPresCheckHours(settings.presCheckHours); }, [JSON.stringify(settings.presCheckHours)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [deletedStack, setDeletedStack] = useState<{designer: Designer; schedule: WeekSchedule[]}[]>([]);

  // Live queue counts from parent (no more manual inputs)
  const preservationQueue = location === 'Utah' ? utahPreservation  : georgiaPreservation;
  const fulfillmentQueue  = location === 'Utah' ? utahFulfillment   : georgiaFulfillment;

  // ── Roster handlers ──────────────────────────────────────────────────────────
  function handleDesignerChange(id: string, field: keyof Designer, value: string) {
    const currentRoster = { ...settings.designRoster };
    const existing = currentRoster[id] ?? designers.find(d => d.id === id) ?? {};
    if (field === 'name')    currentRoster[id] = { ...existing, name: value } as typeof currentRoster[string];
    else if (field === 'payType') currentRoster[id] = { ...existing, payType: value as PayType } as typeof currentRoster[string];
    else currentRoster[id] = { ...existing, [field]: parseFloat(value) || 0 } as typeof currentRoster[string];
    update('designRoster', currentRoster);
  }
  function handleDesignerTemplateChange(id: string, dayIdx: number, value: number) {
    const currentRoster = { ...settings.designRoster };
    const existing = currentRoster[id] ?? designers.find(d => d.id === id) ?? {};
    const prevTemplate = (existing as {standardWeeklyHours?: number[]}).standardWeeklyHours ?? [0, 0, 0, 0, 0, 0, 0];
    const nextTemplate = prevTemplate.map((h, j) => j === dayIdx ? value : h);
    currentRoster[id] = { ...existing, standardWeeklyHours: nextTemplate } as typeof currentRoster[string];
    update('designRoster', currentRoster);

    // Legacy per-week values (designHours) predate the standard-schedule
    // template and outrank it in resolveWeekHours — nothing in the current
    // UI writes new ones, so any left on a future week are stale
    // pre-template leftovers silently shadowing the template. Release just
    // those (current week forward, past weeks kept as historical record) so
    // a template edit actually takes effect. A week the manager has
    // genuinely touched via "This Week" has a real designDailyHours entry —
    // untouched here, so intentional day-level overrides never get wiped.
    const legacyForDesigner = settings.designHours[id];
    if (legacyForDesigner) {
      const nextLegacy = { ...legacyForDesigner };
      let changed = false;
      const currentWeekIso = isoMonday(0);
      for (let w = 0; w < WEEKS; w++) {
        const weekIso = isoMonday(w);
        if (weekIso < currentWeekIso) continue;
        if (nextLegacy[weekIso] === undefined) continue;
        if (designDailyHours[`${weekIso}-${id}`]) continue;
        delete nextLegacy[weekIso];
        changed = true;
      }
      if (changed) update('designHours', { ...settings.designHours, [id]: nextLegacy });
    }
  }
  function handleDesignerEmploymentChange(id: string, field: 'startDate' | 'endDate', value: string) {
    const currentRoster = { ...settings.designRoster };
    const existing = currentRoster[id] ?? designers.find(d => d.id === id) ?? {};
    currentRoster[id] = { ...existing, [field]: value || undefined } as typeof currentRoster[string];
    update('designRoster', currentRoster);
  }
  // Clears every frozen day/week override for this designer from the current
  // week forward (never touches already-elapsed weeks) so they fall back to
  // following whatever the standard schedule template says. Without this,
  // editing someone's template has no visible effect on any week that
  // already has explicit hours sitting in it — which for an actively-used
  // schedule is most near-term weeks.
  function handleResetDesignerToTemplate(id: string) {
    if (!window.confirm('Clear this designer’s scheduled hours from this week forward and go back to following their standard schedule? Past weeks are not affected.')) return;
    const newDaily = { ...designDailyHours };
    let changedDaily = false;
    const newWeekly = { ...settings.designHours };
    let changedWeekly = false;
    for (let w = 0; w < WEEKS; w++) {
      const weekIso = isoMonday(w);
      const dailyKey = `${weekIso}-${id}`;
      if (newDaily[dailyKey]) { delete newDaily[dailyKey]; changedDaily = true; }
      if (newWeekly[id]?.[weekIso] !== undefined) {
        newWeekly[id] = { ...newWeekly[id] };
        delete newWeekly[id][weekIso];
        changedWeekly = true;
      }
    }
    if (changedDaily) { setDesignDailyHours(newDaily); update('designDailyHours', newDaily); }
    if (changedWeekly) update('designHours', newWeekly);
  }
  function handleAddDesigner() {
    const id = `${location.toLowerCase()}-${Date.now()}`;
    const newRoster = { ...settings.designRoster, [id]: { id, name: 'New Designer', ratio: 1.5, payType: 'hourly' as PayType, hourlyRate: 0, annualSalary: 0 } };
    update('designRoster', newRoster);
    // Add empty hours for new designer
    const newHours = { ...settings.designHours, [id]: {} };
    update('designHours', newHours);
  }
  function handleRemoveDesigner(id: string) {
    const designer = designers.find(d => d.id === id);
    if (designer) setDeletedStack(prev => [...prev, { designer, schedule: schedule.map(w => ({ ...w })) }]);
    // Soft-delete: mark as removed so they drop off the active roster, but
    // keep their roster entry and scheduledHours intact for historicals.
    const newRoster = { ...settings.designRoster };
    const existing = newRoster[id] ?? (designer as unknown as typeof newRoster[string]) ?? { ratio: 1.5, payType: 'hourly' as PayType, hourlyRate: 0, annualSalary: 0, name: '' };
    newRoster[id] = { ...existing, _removed: true };
    update('designRoster', newRoster);
  }
  function handleUndo() {
    const last = deletedStack[deletedStack.length - 1];
    if (!last) return;
    // Restore roster entry
    const newRoster = { ...settings.designRoster, [last.designer.id]: last.designer as unknown as typeof settings.designRoster[string] };
    update('designRoster', newRoster);
    setDeletedStack(prev => prev.slice(0, -1));
  }

  // ── Per-designer stats ────────────────────────────────────────────────────────
  // Manager "total hours" (production + managerial) weekly resolution — same
  // override-then-fallback idea as resolveWeekHours, but each day's fallback is
  // that day's already-resolved PRODUCTION hours (not a flat template), so it
  // can't share the generic helper directly.
  function resolveMgrTotalWeekHours(weekIdx: number, designerId: string, productionHrs: number): number {
    const weekIso = isoMonday(weekIdx);
    const weekKey = `${weekIso}-${designerId}`;
    const dailyOverrides = settings.mgrTotalDailyHours[weekKey];
    if (dailyOverrides !== undefined) {
      let sum = 0;
      for (let day = 0; day < 7; day++) {
        const override = dailyOverrides[day];
        sum += override != null ? override
          : resolveDayHours(designDailyHours, `${weekIso}-${designerId}`, day, settings.designRoster[designerId]?.standardWeeklyHours,
              { weekIso, startDate: settings.designRoster[designerId]?.startDate, endDate: settings.designRoster[designerId]?.endDate }).hours;
      }
      return sum;
    }
    return settings.mgrTotalHours[designerId]?.[weekIso] ?? productionHrs;
  }

  function weekStats(weekIdx: number, d: Designer) {
    const hrs    = schedule[weekIdx]?.[d.id] ?? 0;
    const frames = d.ratio > 0 ? hrs / d.ratio : 0;
    const isDesignMgr = !!((settings.designRoster[d.id] as {isManager?:boolean})?.isManager || (d as {isManager?:boolean}).isManager);
    const totalHrs = isDesignMgr ? resolveMgrTotalWeekHours(weekIdx, d.id, hrs) : hrs;
    const cost   = d.payType === 'salary' ? d.annualSalary / 52 : totalHrs * d.hourlyRate;
    const cpo    = !isDesignMgr && frames > 0 && cost > 0 ? cost / frames : null;
    return { hrs, frames, cost, cpo, totalHrs };
  }

  // ── Weekly totals ─────────────────────────────────────────────────────────────
  const weeklyTotals = useMemo(() =>
    Array.from({ length: WEEKS }, (_, w) => {
      let totalFrames = 0, totalCost = 0, totalHours = 0;
      designers.forEach(d => {
        const { frames, cost, hrs } = weekStats(w, d);
        totalFrames += frames;
        totalCost   += cost;
        totalHours  += hrs;
      });
      return { totalFrames, totalCost, totalHours, totalCPO: totalFrames > 0 && totalCost > 0 ? totalCost / totalFrames : null };
    }),
    [schedule, designers] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Monthly aggregation ───────────────────────────────────────────────────────
  const monthlyData = useMemo(() => {
    const map: Record<string, {
      monthKey: string; weeks: number; totalFrames: number; totalCost: number; totalHours: number;
      byDesigner: Record<string, { frames: number; cost: number; hrs: number }>;
    }> = {};
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
      monthlyRatio: m.totalFrames > 0 ? m.totalHours  / m.totalFrames : null,
      monthlyCPO:   m.totalFrames > 0 && m.totalCost > 0 ? m.totalCost / m.totalFrames : null,
    }));
  }, [weeklyTotals, designers, schedule]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actual intake by week (merged: hardcoded historical < team actuals < Supabase actuals) ──
  // Single source of truth for "what actually came in a given week" — used both to graduate
  // the preservation queue and to look up same-week-last-year for projecting future intake.
  const actualIntakeByWeek = useMemo(() => {
    const map: Record<string, number> = {};
    const hardcoded = location === 'Utah' ? UTAH_HISTORICAL_INTAKE : GEORGIA_HISTORICAL_INTAKE;
    hardcoded.forEach(h => { map[h.weekOf] = h.actual; });
    teamActuals.filter(r => r.department === 'preservation').forEach(r => {
      map[r.week_of] = (map[r.week_of] ?? 0) + r.actual_orders;
    });
    Object.entries(presActuals).forEach(([weekOf, val]) => { map[weekOf] = val; });
    return map;
  }, [location, teamActuals, presActuals]);

  const intakeMultiplierKey = location === 'Utah' ? 'ut' : 'ga';
  function getIntakeMultiplier(weekOf: string): number {
    return weeklyMultipliers[weekOf]?.[intakeMultiplierKey] ?? DEFAULT_INTAKE_MULTIPLIER;
  }
  // Projected intake = same week last year's actual × that week's multiplier (default 1.2).
  function getProjectedIntake(weekOf: string): number | undefined {
    const lastYearActual = actualIntakeByWeek[addDays(weekOf, -364)];
    if (lastYearActual === undefined) return undefined;
    return Math.round(lastYearActual * getIntakeMultiplier(weekOf));
  }

  // The exact "Bouquets received" estimate shown per week on Design's Queue &
  // Turnaround tab (manual weeklyEstimates override, else last-year×multiplier
  // projection, else avgIntake) — reused as-is for Preservation's own arrivals
  // stream, so both tabs can never disagree about how many bouquets are
  // expected in a given week.
  const bouquetsReceivedByWeek = useMemo(() => Array.from({ length: WEEKS }, (_, w) => {
    const weekIso = isoMonday(w);
    const weVal = weeklyEstimates[weekIso];
    if (weVal !== undefined) return location === 'Utah' ? weVal.ut : weVal.ga;
    const projected = getProjectedIntake(weekIso);
    if (projected !== undefined) return projected;
    return avgIntake;
  }), [weeklyEstimates, location, actualIntakeByWeek, weeklyMultipliers, avgIntake]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Graduating cohorts (preservation → designable, per week) ────────────────
  const graduatingCohorts = useMemo(() => {
    const taByWeek: Record<string, number> = {};
    teamActuals.filter(r => r.department === 'preservation').forEach(r => {
      taByWeek[r.week_of] = (taByWeek[r.week_of] ?? 0) + r.actual_orders;
    });
    return Array.from({ length: WEEKS }, (_, w) => {
      const graduatingDate = getMondayDate(w - PRESERVATION_WEEKS);
      const graduatingIso  = graduatingDate.toISOString().split('T')[0];
      const intakeData     = location === 'Utah' ? UTAH_HISTORICAL_INTAKE : GEORGIA_HISTORICAL_INTAKE;
      // Priority: 1) Supabase actuals, 2) team actuals total, 3) hardcoded historical, 4) per-week estimate,
      // 5) projected (last year's same week × multiplier), 6) avg
      if (presActuals[graduatingIso] !== undefined) return presActuals[graduatingIso];
      if (taByWeek[graduatingIso] !== undefined) return taByWeek[graduatingIso];
      const hist = intakeData.find(h => h.weekOf === graduatingIso);
      if (hist) return hist.actual;
      const _we = weeklyEstimates[graduatingIso]; if (_we !== undefined) return location === 'Utah' ? _we.ut : _we.ga;
      const projected = getProjectedIntake(graduatingIso);
      if (projected !== undefined) return projected;
      return avgIntake;
    });
  }, [avgIntake, presActuals, weeklyEstimates, location, teamActuals, actualIntakeByWeek, weeklyMultipliers]);

  // ── Cohort intake (actual bouquets received from Preservation) ─────────────
  // Single source of truth for "how many orders are actually backed up
  // waiting to be designed right now" — built entirely from real
  // received-bouquet data (hardcoded historical intake + presActuals +
  // teamActuals), anchored to already-designed progress via
  // DESIGNED_BASELINE. Deliberately never touches the live Shopify/PF status
  // snapshot (readyToFrame/almostReadyToFrame) — that's a real-time count of
  // a different thing (current order status), not a measure of the
  // FIFO design queue derived from what Preservation has actually delivered.
  // Both the per-cohort "Weeks remaining until design" table and the
  // aggregate "Future turnaround" queue-clearing simulation read from this,
  // so they can never disagree about the backlog.
  const cohortIntake = useMemo(() => {
    const hardcoded = location === 'Utah' ? UTAH_HISTORICAL_INTAKE : GEORGIA_HISTORICAL_INTAKE;
    const teamActualsByWeek: Record<string, number> = {};
    teamActuals.filter(r => r.department === 'preservation').forEach(r => {
      teamActualsByWeek[r.week_of] = (teamActualsByWeek[r.week_of] ?? 0) + r.actual_orders;
    });
    const allWeeks = new Set([...hardcoded.map(h => h.weekOf), ...Object.keys(presActuals), ...Object.keys(teamActualsByWeek)]);
    const historicalIntake = [...allWeeks].sort().map(weekOf => ({
      weekOf,
      actual: presActuals[weekOf] ?? teamActualsByWeek[weekOf] ?? hardcoded.find(h => h.weekOf === weekOf)?.actual ?? 0,
    })).filter(h => h.actual > 0);
    const today = getMondayDate(0);
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
    const totalFromHistory = designableCohorts.reduce((s, c) => s + c.count, 0);
    // Designed-to-date = baseline + sum of actual frames from design historicals
    const designedActualsTotal = teamActuals
      .filter(r => r.department === 'design')
      .reduce((s, r) => s + (r.actual_orders ?? 0), 0);
    const alreadyDesigned = Math.max(0, Math.min(totalFromHistory,
      (DESIGNED_BASELINE[location] ?? 0) + designedActualsTotal));
    const remainingQueue = Math.max(0, totalFromHistory - alreadyDesigned);
    return { designableCohorts, inPreservationCohorts, totalFromHistory, alreadyDesigned, remainingQueue };
  }, [location, presActuals, teamActuals]);

  // ── Hiring / what-if plan ────────────────────────────────────────────────────
  // Powers the Design hours columns on the Queue & Turnaround tab. The only
  // manager-editable lever is a hypothetical new hire's hours/wk, which carries
  // forward into every later week once they'd have started. "Planned" is always
  // exactly Scheduled + those hire hours — the same capacity that drives the
  // Planned turnaround bar — so the two views can never disagree.
  const hiringPlan = useMemo(() => {
    const baseHours    = weeklyTotals.map(t => t.totalHours);
    const baseCapacity = weeklyTotals.map(t => t.totalFrames);
    let ratioSumFrames = 0, ratioSumHours = 0;
    weeklyTotals.forEach(t => { if (t.totalFrames > 0) { ratioSumFrames += t.totalFrames; ratioSumHours += t.totalHours; } });
    const blendedRatio = ratioSumFrames > 0 ? ratioSumHours / ratioSumFrames
      : (designers.length > 0 ? designers.reduce((s, d) => s + d.ratio, 0) / designers.length : 1);
    const hoursPerFrame = weeklyTotals.map(t => t.totalFrames > 0 ? t.totalHours / t.totalFrames : (blendedRatio || 1));

    // New-hire hours carry forward: once someone starts, their hours count
    // toward every week from their start week on, not just the entry week.
    let cumulativeHireHours = 0;
    const hireHoursByWeek: number[] = [];
    for (let w = 0; w < WEEKS; w++) {
      cumulativeHireHours += settings.newHireHours[isoMonday(w)] ?? 0;
      hireHoursByWeek.push(cumulativeHireHours);
    }

    // "Scheduled" stays exactly what's in the Weekly Schedule tab — hires are a
    // planning tool, not something that should silently inflate it. A hire's
    // hours only ever show up on the Planned side, until someone actually goes
    // and enters them into the real schedule.
    const scheduledHours = baseHours;
    const plannedHours   = baseHours.map((h, w) => h + hireHoursByWeek[w]);
    const planCapacity   = baseCapacity.map((f, w) => f + hireHoursByWeek[w] / NEW_HIRE_RATIO);
    const planTurnaround = simulateDesignTurnarounds(cohortIntake.remainingQueue, graduatingCohorts, planCapacity);
    // Pure as-scheduled turnaround — no hypothetical hires, no overrides — so
    // "Scheduled" and "Planned" can be shown side by side as a true before/after.
    const scheduledTurnaround = simulateDesignTurnarounds(cohortIntake.remainingQueue, graduatingCohorts, baseCapacity);

    // Clocked-vs-scheduled trend: for weeks with both a schedule entered and
    // actual hours logged, how does real clocked time compare to what was
    // scheduled? Widens each bar's single number into a range (best case = at
    // full scheduled pace, worst case = if that trend continues) instead of a
    // separate row.
    const scheduledByWeek: Record<string, number> = {};
    Object.values(settings.designHours).forEach(perWeek => {
      Object.entries(perWeek ?? {}).forEach(([weekOf, hrs]) => {
        scheduledByWeek[weekOf] = (scheduledByWeek[weekOf] ?? 0) + (hrs ?? 0);
      });
    });
    const actualByWeek: Record<string, number> = {};
    teamActuals.filter(r => r.department === 'design').forEach(r => {
      actualByWeek[r.week_of] = (actualByWeek[r.week_of] ?? 0) + (r.actual_hours ?? 0);
    });
    const trendRatios = Object.keys(actualByWeek)
      .filter(w => (scheduledByWeek[w] ?? 0) > 0)
      .map(w => actualByWeek[w] / scheduledByWeek[w]);
    const trendRatio = trendRatios.length > 0 ? trendRatios.reduce((s, r) => s + r, 0) / trendRatios.length : null;

    const scheduledTurnaroundTrend = trendRatio !== null
      ? simulateDesignTurnarounds(cohortIntake.remainingQueue, graduatingCohorts, baseCapacity.map(f => f * trendRatio))
      : scheduledTurnaround;
    const planTurnaroundTrend = trendRatio !== null
      ? simulateDesignTurnarounds(cohortIntake.remainingQueue, graduatingCohorts, planCapacity.map(f => f * trendRatio))
      : planTurnaround;

    // Unclamped mirrors of the same four — see simulateDesignTurnaroundsUnclamped's
    // comment. Only consulted once a week has already hit the real
    // PRESERVATION_WEEKS floor, to size how overstaffed it is.
    const scheduledTurnaroundUnclamped = simulateDesignTurnaroundsUnclamped(cohortIntake.remainingQueue, graduatingCohorts, baseCapacity);
    const planTurnaroundUnclamped      = simulateDesignTurnaroundsUnclamped(cohortIntake.remainingQueue, graduatingCohorts, planCapacity);
    const scheduledTurnaroundTrendUnclamped = trendRatio !== null
      ? simulateDesignTurnaroundsUnclamped(cohortIntake.remainingQueue, graduatingCohorts, baseCapacity.map(f => f * trendRatio))
      : scheduledTurnaroundUnclamped;
    const planTurnaroundTrendUnclamped = trendRatio !== null
      ? simulateDesignTurnaroundsUnclamped(cohortIntake.remainingQueue, graduatingCohorts, planCapacity.map(f => f * trendRatio))
      : planTurnaroundUnclamped;

    return {
      scheduledHours, plannedHours, planTurnaround, scheduledTurnaround, hireHoursByWeek,
      scheduledTurnaroundTrend, planTurnaroundTrend, hoursPerFrame,
      scheduledTurnaroundUnclamped, planTurnaroundUnclamped,
      scheduledTurnaroundTrendUnclamped, planTurnaroundTrendUnclamped,
    };
  }, [weeklyTotals, designers, settings.newHireHours, settings.designHours, teamActuals, cohortIntake.remainingQueue, graduatingCohorts]);

  // Combine a base turnaround value with its trend-adjusted counterpart into a
  // single display string — a range when they differ, else just one number.
  function turnaroundRangeLabel(base: number | null, trend: number | null): string {
    if (base === null) return '52wk+';
    if (trend === null) return `${base}w+`;
    if (trend === base) return `${base}w`;
    const lo = Math.min(base, trend), hi = Math.max(base, trend);
    return `${lo}–${hi}w`;
  }

  function setNewHireHours(weekIso: string, hours: number) {
    const next = { ...settings.newHireHours };
    if (hours > 0) next[weekIso] = hours; else delete next[weekIso];
    update('newHireHours', next);
  }


  // ── Historical remaining ─────────────────────────────────────────────────────
  const historicalRemaining = useMemo(() => {
    const { designableCohorts, inPreservationCohorts, alreadyDesigned } = cohortIntake;
    if (!designableCohorts.length && !inPreservationCohorts.length) return [];
    let trimRemaining = alreadyDesigned;
    const queueCohorts: { weekOf: string; remaining: number }[] = [];
    for (const c of designableCohorts) {
      if (trimRemaining >= c.count) {
        queueCohorts.push({ weekOf: c.weekOf, remaining: 0 });
        trimRemaining -= c.count;
      } else {
        queueCohorts.push({ weekOf: c.weekOf, remaining: c.count - trimRemaining });
        trimRemaining = 0;
      }
    }
    const results: { weekOf: string; weeksFromNow: number | null; alreadyDone: boolean; remaining: number }[] =
      queueCohorts.map(c => ({ weekOf: c.weekOf, weeksFromNow: null, alreadyDone: c.remaining === 0, remaining: c.remaining }));
    const presResults: { weekOf: string; weeksFromNow: number | null; alreadyDone: boolean; inPreservation: boolean; preservationWeeksLeft: number; remaining: number }[] =
      inPreservationCohorts.map(c => ({ weekOf: c.weekOf, weeksFromNow: null, alreadyDone: false, inPreservation: true, preservationWeeksLeft: c.weeksLeft, remaining: c.count }));
    // Single FIFO simulation across the already-graduated queue AND every
    // still-drying cohort together, in chronological order. A still-drying
    // cohort's preservationWeeksLeft only makes it ELIGIBLE to start
    // consuming capacity once it graduates — it does not give it its own
    // private copy of every future week's capacity. Simulating drying
    // cohorts independently (each assuming it alone gets full access to
    // capacity from its own join week onward) let multiple cohorts land on
    // the same "weeks until designed" even though only one of them can
    // actually be designed at a time — this keeps every cohort honestly
    // queued behind whichever ones (graduated or still drying) are ahead of
    // it, so promised dates line up with what the schedule can deliver.
    type Row = (typeof results)[number] | (typeof presResults)[number];
    const allRows: Row[] = [...results, ...presResults];
    const joinWeekOf = (r: Row) => 'preservationWeeksLeft' in r ? r.preservationWeeksLeft : 0;
    let idx = allRows.findIndex(r => r.remaining > 0);
    if (idx === -1) idx = allRows.length;
    let remainingInRow = allRows[idx]?.remaining ?? 0;
    for (let w = 0; w < WEEKS && idx < allRows.length; w++) {
      let capacity = weeklyTotals[w].totalFrames;
      while (capacity > 0 && idx < allRows.length && joinWeekOf(allRows[idx]) <= w) {
        if (remainingInRow <= capacity) {
          allRows[idx].weeksFromNow = w;
          capacity -= remainingInRow;
          idx++;
          remainingInRow = allRows[idx]?.remaining ?? 0;
        } else {
          remainingInRow -= capacity;
          capacity = 0;
        }
      }
    }
    return allRows.sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  }, [cohortIntake, weeklyTotals]);

  // ── Must design ───────────────────────────────────────────────────────────────
  // Minimum output each schedule week needs so no locked-in client promise
  // (from designPromises) gets missed. Each active cohort's `remaining` count
  // becomes "due" in the earliest schedule week on/after its promised_by_date;
  // due amounts accumulate, and each week's minimum is whatever's needed on top
  // of what's already scheduled in prior weeks to keep cumulative pace. Never
  // below what's already scheduled that week, and a week that falls short
  // simply raises next week's requirement, so it self-corrects.
  const mustDesignByWeek = useMemo(() => {
    const cumulativeRequired = Array.from({ length: WEEKS }, () => 0);
    historicalRemaining
      .filter(row => !('alreadyDone' in row && row.alreadyDone) && row.remaining > 0)
      .forEach(row => {
        const promise = designPromises[row.weekOf];
        if (!promise) return;
        let dueWeek = WEEKS - 1;
        for (let w = 0; w < WEEKS; w++) {
          if (isoMonday(w) >= promise.promisedByDate) { dueWeek = w; break; }
        }
        cumulativeRequired[dueWeek] += row.remaining;
      });
    for (let w = 1; w < WEEKS; w++) cumulativeRequired[w] += cumulativeRequired[w - 1];

    const mustDesign: number[] = [];
    let cumulativeScheduled = 0;
    for (let w = 0; w < WEEKS; w++) {
      const scheduled = weeklyTotals[w].totalFrames;
      mustDesign.push(Math.max(scheduled, cumulativeRequired[w] - cumulativeScheduled));
      cumulativeScheduled += scheduled;
    }
    return mustDesign;
  }, [historicalRemaining, designPromises, weeklyTotals]);

  const windowWeeks = Array.from({ length: WINDOW }, (_, i) => i + weekOffset).filter(i => i < WEEKS);
  const hasRates    = canViewCPO && designers.some(d =>
    (d.payType === 'hourly' && d.hourlyRate > 0) ||
    (d.payType === 'salary' && d.annualSalary > 0)
  );

  return (
    <div className="space-y-6">

      {/* ── Dept tabs + Location toggle + Save indicator ────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1 flex-wrap">
            {([
              ['design',       'Design'],
              ['preservation', 'Preservation'],
              ['fulfillment',  'Fulfillment'],
              ['master',       'Master Schedule'],
              ['payroll',      'Payroll Upload'],
              ['resin',        'Resin'],
            ] as const).filter(([id]) => {
              if (userRole === 'manager' && userDepartment) {
                return id === userDepartment;
              }
              if (userRole === 'viewer') {
                return ['design', 'preservation', 'resin'].includes(id);
              }
              return true;
            }).map(([id, label]) => (
              <button key={id} onClick={() => setDept(id)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  dept === id
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                {label}
              </button>
            ))}
          </div>
          {/* Save state indicator */}
          {settingsLoading && (
            <span className="text-xs text-slate-400 italic">Loading saved settings…</span>
          )}
          {saveState === 'saving' && (
            <span className="text-xs text-slate-400">Saving…</span>
          )}
          {saveState === 'saved' && (
            <span className="text-xs text-green-600">✓ Saved</span>
          )}
          {saveState === 'error' && (
            <span className="text-xs text-red-500">Save failed — check connection</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
            {(['Utah', 'Georgia'] as const).map(loc => (
              <button key={loc} onClick={() => setLocation(loc)}
                className={`px-5 py-2 transition-colors ${
                  location === loc ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}>
                {loc}
              </button>
            ))}
          </div>
          {!canEditCurrent && (
            <span className="text-xs bg-amber-50 text-amber-600 border border-amber-200 px-2 py-0.5 rounded-full">
              View only
            </span>
          )}
        </div>
      </div>

      {/* ── PRESERVATION dept ───────────────────────────────────────────────── */}
      {dept === 'preservation' && (
        <>
        <DeptKPIBar dept="preservation" location={location} kpiState={kpiMetrics} showCPO={hasAnyRates} />
        <PreservationSection
          location={location}
          preservationQueue={preservationQueue}
          countsLoading={countsLoading}
          teamActuals={teamActuals}
          canViewCPO={canViewCPO}
          presHours={settings.presHours}
          presDailyHours={presDailyHours}
          presCheckHours={presCheckHours}
          onPresDailyHoursChange={(h) => { setPresDailyHours(h); update('presDailyHours', h); }}
          onPresCheckHoursChange={(h) => { setPresCheckHours(h); update('presCheckHours', h); }}
          presRoster={settings.presRoster}
          presSettings={settings.presSettings}
          mgrTotalHours={settings.mgrTotalHours}
          mgrTotalDailyHours={settings.mgrTotalDailyHours}
          onPresHoursChange={(h) => update('presHours', h)}
          onPresRosterChange={(r) => update('presRoster', r)}
          onPresSettingsChange={(s) => update('presSettings', s)}
          onMgrTotalHoursChange={(h) => update('mgrTotalHours', h)}
          onMgrTotalDailyHoursChange={(h) => update('mgrTotalDailyHours', h)}
          employeeRates={employeeRates}
          weeklyEstimates={weeklyEstimates}
          presActuals={presActuals}
          bouquetsReceivedByWeek={bouquetsReceivedByWeek}
          presNewHireHours={settings.presNewHireHours}
          onPresNewHireHoursChange={(h) => update('presNewHireHours', h)}
          onReceivedSaved={() => {
            fetch(`/api/actuals?location=${location}&type=preservation&weeks=52`)
              .then(r => r.json())
              .then((d: { preservationActuals?: { week_of: string; received: number }[] }) => {
                const map: Record<string, number> = {};
                (d.preservationActuals ?? []).forEach(row => { map[row.week_of] = row.received; });
                setPresActuals(map);
              })
              .catch(() => {});
          }}
          onActualsSaved={() => {
            fetch(`/api/actuals?location=${location}&type=all&weeks=52`)
              .then(r => r.json())
              .then((d: { preservationActuals?: { week_of: string; received: number }[]; teamActuals?: typeof teamActuals }) => {
                const map: Record<string, number> = {};
                (d.preservationActuals ?? []).forEach(row => { map[row.week_of] = row.received; });
                setPresActuals(map);
                setTeamActuals(d.teamActuals ?? []);
              })
              .catch(() => {});
          }}
        />
        </>
      )}

      {/* ── FULFILLMENT dept ────────────────────────────────────────────────── */}
      {dept === 'fulfillment' && (
        <>
        <DeptKPIBar dept="fulfillment" location={location} kpiState={kpiMetrics} showCPO={hasAnyRates} />
        <FulfillmentSection
          location={location}
          fulfillmentQueue={fulfillmentQueue}
          countsLoading={countsLoading}
          teamActuals={teamActuals}
          canViewCPO={canViewCPO}
          ffHours={settings.ffHours}
          ffRoster={settings.ffRoster}
          mgrTotalHours={settings.mgrTotalHours}
          mgrTotalDailyHours={settings.mgrTotalDailyHours}
          onFfHoursChange={(h) => update('ffHours', h)}
          onFfRosterChange={(r) => update('ffRoster', r)}
          onMgrTotalHoursChange={(h) => update('mgrTotalHours', h)}
          onMgrTotalDailyHoursChange={(h) => update('mgrTotalDailyHours', h)}
          ffDailyHoursProp={settings.ffDailyHours}
          onFfDailyHoursChange={(h) => update('ffDailyHours', h)}
          designWeeklyFrames={weeklyTotals.map(t => t.totalFrames)}
          ffNewHireHours={settings.ffNewHireHours}
          onFfNewHireHoursChange={(h) => update('ffNewHireHours', h)}
          onActualsSaved={() => {
            fetch(`/api/actuals?location=${location}&type=team&weeks=52`)
              .then(r => r.json())
              .then((d: { teamActuals?: typeof teamActuals }) => setTeamActuals(d.teamActuals ?? []))
              .catch(() => {});
          }}
        />
        </>
      )}

      {/* ── DESIGN dept ─────────────────────────────────────────────────────── */}
      {dept === 'design' && (
        <>
          <DeptKPIBar dept="design" location={location} kpiState={kpiMetrics} showCPO={hasAnyRates} />

          {/* Est. bouquets delivered — fallback intake estimate used when no
              per-week estimate is set (see Queue & Turnaround); this is the
              only summary card here that feeds a live calculation, so it
              stays even with the pure-readout queue/capacity cards removed. */}
          <div className="bg-white border border-slate-100 rounded-xl p-4 inline-flex items-center gap-3 w-fit">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Est. bouquets/week delivered</p>
              <p className="text-xs text-slate-400">fallback when no per-week estimate set</p>
            </div>
            <input type="number" value={avgIntake} onChange={e => setAvgIntake(parseInt(e.target.value) || 0)}
              className="w-20 border border-slate-200 rounded px-2 py-1 text-xl font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300" />
          </div>

          {/* Roster editor */}
          <div>
            <button onClick={() => setShowRoster(r => !r)}
              className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
              {showRoster ? '▲ Hide' : '▼ Edit'} designer roster, ratios &amp; pay rates
            </button>
            {showRoster && (
              <div className="mt-3 bg-white border border-slate-100 rounded-xl p-5">
                <RosterEditor
                  designers={designers}
                  onChange={handleDesignerChange}
                  onAdd={handleAddDesigner}
                  onRemove={handleRemoveDesigner}
                  location={location}
                  standardWeeklyHoursById={Object.fromEntries(designers.map(d => [d.id, settings.designRoster[d.id]?.standardWeeklyHours]))}
                  onTemplateChange={handleDesignerTemplateChange}
                  onResetToTemplate={handleResetDesignerToTemplate}
                  employmentById={Object.fromEntries(designers.map(d => [d.id, { startDate: settings.designRoster[d.id]?.startDate, endDate: settings.designRoster[d.id]?.endDate }]))}
                  onEmploymentChange={handleDesignerEmploymentChange}
                />
                {deletedStack.length > 0 && (
                  <button onClick={handleUndo}
                    className="mt-3 text-xs px-3 py-1 border border-amber-200 rounded text-amber-600 hover:bg-amber-50 transition-colors">
                    ↩ Undo remove &quot;{deletedStack[deletedStack.length - 1].designer.name}&quot;
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Inner tabs */}
          <div className="flex border-b border-slate-200">
            {([
              ['thisweek',    'This Week'],
              ['schedule',    'Weekly Schedule'],
              ['queue',       'Queue & Turnaround'],
              ['monthly',     'Monthly Summary'],
              ['historicals', 'Historicals'],
            ] as const).filter(([id]) => {
              if (userRole === 'viewer') return ['thisweek', 'queue'].includes(id);
              return true;
            }).map(([id, label]) => (
              <button key={id} onClick={() => setActiveTab(id)}
                className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === id
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {/* ── WEEKLY SCHEDULE TAB ─────────────────────────────────────────── */}
          {activeTab === 'thisweek' && (() => {
            const days = getWeekdays(designThisWeekOffset);
            function getDH(id: string, di: number) {
              const weekIso = isoMonday(designThisWeekOffset);
              return resolveDayHours(designDailyHours, `${weekIso}-${id}`, di, settings.designRoster[id]?.standardWeeklyHours,
                { weekIso, startDate: settings.designRoster[id]?.startDate, endDate: settings.designRoster[id]?.endDate }).hours;
            }
            function isDHOverride(id: string, di: number) {
              const weekIso = isoMonday(designThisWeekOffset);
              return resolveDayHours(designDailyHours, `${weekIso}-${id}`, di, settings.designRoster[id]?.standardWeeklyHours,
                { weekIso, startDate: settings.designRoster[id]?.startDate, endDate: settings.designRoster[id]?.endDate }).isOverride;
            }
            function setDH(id: string, di: number, val: number) {
              const weekIso = isoMonday(designThisWeekOffset);
              const key = `${weekIso}-${id}`;
              const padded = [...baseDailyArray(designDailyHours, key, settings.designHours[id]?.[weekIso], isoMonday(0))];
              padded[di] = val;
              const next = { ...designDailyHours, [key]: padded };
              setDesignDailyHours(next);
              update('designDailyHours', next);
            }
            function getMgrTotalDH(id: string, di: number) {
              const override = settings.mgrTotalDailyHours[`${isoMonday(designThisWeekOffset)}-${id}`]?.[di];
              return override != null ? override : getDH(id, di);
            }
            function setMgrTotalDH(id: string, di: number, val: number) {
              const key = `${isoMonday(designThisWeekOffset)}-${id}`;
              const padded = [...(settings.mgrTotalDailyHours[key] ?? [null, null, null, null, null, null, null])];
              padded[di] = val;
              const next = { ...settings.mgrTotalDailyHours, [key]: padded };
              update('mgrTotalDailyHours', next);
            }
            function dDailyCost(d: Designer, di: number) {
              const isMgr = (d as {isManager?:boolean}).isManager;
              const h = isMgr ? getMgrTotalDH(d.id, di) : getDH(d.id, di);
              return d.payType === 'salary' ? d.annualSalary / 260 : h * d.hourlyRate;
            }
            const teamDailyFrames = (di: number) => designers.reduce((s, d) => {
              const h = getDH(d.id, di); return s + (d.ratio > 0 && h > 0 ? h / d.ratio : 0);
            }, 0);
            const teamDailyCost = (di: number) => designers.reduce((s, d) => s + dDailyCost(d, di), 0);
            const teamWeekFrames = days.reduce((s, _, di) => s + teamDailyFrames(di), 0);
            return (
              <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-700">Hours per designer per day — {designThisWeekOffset === 0 ? 'this week' : designThisWeekOffset === 1 ? 'next week' : `week +${designThisWeekOffset}`}</h3>
                    <p className="text-xs text-slate-400 mt-0.5">{days[0]?.dateStr} – {days[4]?.dateStr} · Frames calculated from each designer&apos;s ratio.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {hasRates && <span className="text-xs text-slate-400 mr-2">CPO shown when rate is set</span>}
                    <InputModeToggle mode={designInputMode} onChange={setDesignInputMode} unitLabel="Frames" />
                    <button onClick={() => setDesignThisWeekOffset(Math.max(0, designThisWeekOffset - 1))} disabled={designThisWeekOffset === 0} className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
                    <button onClick={() => setDesignThisWeekOffset(Math.min(maxDesignThisWeekOffset, designThisWeekOffset + 1))} disabled={designThisWeekOffset >= maxDesignThisWeekOffset} className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-100">
                        <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 min-w-[140px]">Designer</th>
                        {days.map((d, i) => (
                          <th key={i} className={`px-2 py-2 text-center font-medium min-w-[90px] whitespace-nowrap ${i === 0 ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500'}`}>
                            {d.label}<br /><span className="font-normal text-[10px]">{d.dateStr}</span>
                          </th>
                        ))}
                        <th className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap">Week total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {designers.map((d, di) => {
                        const isMgr = !!((settings.designRoster[d.id] as {isManager?:boolean})?.isManager || (d as {isManager?:boolean}).isManager);
                        const weekFrames = days.reduce((s, _, dayIdx) => { const h = getDH(d.id, dayIdx); return s + (d.ratio > 0 && h > 0 ? h / d.ratio : 0); }, 0);
                        const weekHrs = days.reduce((s, _, dayIdx) => s + (isMgr ? getMgrTotalDH(d.id, dayIdx) : getDH(d.id, dayIdx)), 0);
                        const weekCost = days.reduce((s, _, dayIdx) => s + dDailyCost(d, dayIdx), 0);
                        const weekCPO = weekFrames > 0 && weekCost > 0 ? weekCost / weekFrames : null;
                        return (
                          <tr key={d.id} className={`border-b border-slate-50 ${di % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                            <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap">
                              <div className="font-medium text-slate-700">{d.name}</div>
                              <div className="text-slate-400">{d.ratio} h/f</div>
                              {d.payType === 'salary' && <div className="text-[10px] text-amber-600">salary</div>}
                            </td>
                            {days.map((_, dayIdx) => {
                              const h = getDH(d.id, dayIdx);
                              const isOverride = isDHOverride(d.id, dayIdx);
                              const totalH = isMgr ? getMgrTotalDH(d.id, dayIdx) : h;
                              const frames = d.ratio > 0 && h > 0 ? h / d.ratio : 0;
                              const cost = dDailyCost(d, dayIdx);
                              const cpo = !isMgr && frames > 0 && cost > 0 ? cost / frames : null;
                              return (
                                <td key={dayIdx} className={`px-2 py-1.5 text-center ${dayIdx === 0 ? 'bg-indigo-50/30' : ''}`}>
                                  <input type="number"
                                    value={designInputMode === 'output' ? (frames ? round2(frames) : '') : (h || '')}
                                    min="0" step={designInputMode === 'output' ? '0.1' : '0.5'} placeholder="0"
                                    title={isOverride ? 'Explicit override for this day' : 'Following the standard weekly schedule — edit to override just this day'}
                                    onChange={e => {
                                      const raw = parseFloat(e.target.value) || 0;
                                      setDH(d.id, dayIdx, designInputMode === 'output' ? hoursFromOutput(raw, d.ratio) : raw);
                                    }}
                                    className={`w-14 border rounded px-1.5 py-1 text-center bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 ${
                                      isOverride ? 'border-slate-200 text-slate-700' : 'border-slate-100 text-slate-400 italic'
                                    }`} />
                                  {isMgr && (
                                    <input type="number" value={totalH || ''} min="0" step="0.5" placeholder="total h"
                                      title="Total hours (production + managerial)"
                                      onChange={e => setMgrTotalDH(d.id, dayIdx, parseFloat(e.target.value) || 0)}
                                      className="w-14 mt-0.5 border border-violet-200 rounded px-1.5 py-0.5 text-center text-[10px] text-violet-600 bg-violet-50 focus:outline-none focus:ring-1 focus:ring-violet-300" />
                                  )}
                                  {designInputMode === 'output'
                                    ? (h > 0 && <div className="text-slate-400 mt-0.5">{round2(h)}h</div>)
                                    : (frames > 0 && <div className="text-slate-400 mt-0.5">{round2(frames)}f</div>)}
                                  {hasRates && cpo !== null && <div className="text-amber-600 text-[10px]">{fmt$(cpo)}</div>}
                                </td>
                              );
                            })}
                            <td className="px-3 py-2 text-center">
                              <div className="font-medium text-indigo-700">{Math.round(weekFrames * 100) / 100}f</div>
                              <div className="text-slate-400 text-[10px]">{weekHrs}h</div>
                              {hasRates && !isMgr && weekCPO !== null && <div className="text-amber-600 text-[10px]">{fmt$(weekCPO)}</div>}
                            </td>
                          </tr>
                        );
                      })}
                      <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                        <td className="sticky left-0 bg-slate-50 px-4 py-2 text-xs text-slate-600">Daily total</td>
                        {days.map((_, di) => {
                          const f = Math.round(teamDailyFrames(di) * 100) / 100; const cc = teamDailyCost(di);
                          const cpo = f > 0 && cc > 0 ? cc / f : null;
                          const designDayHours = designers.reduce((s, d) => s + getDH(d.id, di), 0);
                          const designDayRatio = f > 0 ? designDayHours / f : null;
                          return (
                            <td key={di} className={`px-2 py-2 text-center ${di === 0 ? 'bg-indigo-50/50' : ''}`}>
                              <div className="text-indigo-700">{f}f</div>
                              {designDayRatio !== null && <div className="text-[10px] text-slate-500">{Math.round(designDayRatio * 100) / 100} h/f</div>}
                              {hasRates && cpo !== null && <div className="text-[10px] text-amber-600">{fmt$(cpo)}</div>}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-center font-semibold text-indigo-700">{Math.round(teamWeekFrames * 100) / 100}f</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

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
                  <InputModeToggle mode={designInputMode} onChange={setDesignInputMode} unitLabel="Frames" />
                  <button onClick={() => setWeekOffset(Math.max(0, weekOffset - WINDOW))} disabled={weekOffset === 0}
                    className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
                  <span className="text-xs text-slate-400">
                    {getWeekLabel(weekOffset)} – {getWeekLabel(weekOffset + WINDOW - 1)}
                  </span>
                  <button onClick={() => setWeekOffset(Math.min(WEEKS - WINDOW, weekOffset + WINDOW))} disabled={weekOffset + WINDOW >= WEEKS}
                    className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap min-w-[140px]">Designer</th>
                      {windowWeeks.map(w => (
                        <th key={w} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[90px]">
                          {getWeekLabel(w)}
                          {w === 0 && <span className="ml-1 text-[10px] bg-indigo-100 text-indigo-600 rounded px-1">now</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {designers.map((d, di) => (
                      <tr key={d.id} className={`border-b border-slate-50 ${di % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                        <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap">
                          <div className="font-medium text-slate-700">{d.name}</div>
                          <div className="text-slate-400">{d.ratio} h/f</div>
                          {d.payType === 'salary' && <div className="text-[10px] text-amber-600">salary</div>}
                        </td>
                        {windowWeeks.map(w => {
                          const { hrs, frames, cpo, totalHrs } = weekStats(w, d);
                          const isDesignMgr = !!((settings.designRoster[d.id] as {isManager?:boolean})?.isManager || (d as {isManager?:boolean}).isManager);
                          return (
                            <td key={w} className={`px-2 py-1.5 text-center ${w === 0 ? 'bg-indigo-50/30' : ''}`}>
                              <div className="text-slate-700 font-medium" title="Set on the Roster (standard schedule) or the This Week tab (one-off exceptions) — Weekly Schedule is a read-only view">
                                {designInputMode === 'output' ? round2(frames) : round2(hrs)}
                              </div>
                              {isDesignMgr && totalHrs !== hrs && (
                                <div className="text-[10px] text-violet-600" title="Total hours (production + managerial)">{round2(totalHrs)}h total</div>
                              )}
                              {designInputMode === 'output'
                                ? (hrs > 0 && <div className="text-slate-400 mt-0.5">{round2(hrs)}h</div>)
                                : (frames > 0 && <div className="text-slate-400 mt-0.5">{Math.round(frames)}f</div>)}
                              {showCPO && !isDesignMgr && cpo !== null && (
                                <div className="text-amber-600 text-[10px]">{fmt$(cpo)}</div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {/* Totals row */}
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                      <td className="sticky left-0 bg-slate-50 px-4 py-2 text-xs text-slate-600">Week total</td>
                      {windowWeeks.map(w => {
                        const t = weeklyTotals[w];
                        return (
                          <td key={w} className={`px-2 py-2 text-center ${w === 0 ? 'bg-indigo-50/50' : ''}`}>
                            <div className="text-indigo-700">{Math.round(t.totalFrames)}f</div>
                            {hasRates && t.totalCPO !== null && (
                              <div className="text-amber-600 text-[10px]">{fmt$(t.totalCPO)}</div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    {/* Must design row — the minimum this week needs to hit so no client
                        promise locked in via "Send biweekly bloom update" (Queue & Turnaround
                        tab) gets missed. Never below what's already scheduled; a short week
                        just raises next week's minimum, so it self-corrects. */}
                    <tr className="border-t border-slate-100 bg-red-50/40">
                      <td className="sticky left-0 bg-red-50/40 px-4 py-2 text-xs text-slate-500 whitespace-nowrap">Must design</td>
                      {windowWeeks.map(w => {
                        const must      = mustDesignByWeek[w];
                        const scheduled = weeklyTotals[w].totalFrames;
                        const short     = must - scheduled;
                        const hpf       = hiringPlan.hoursPerFrame[w] || 1;
                        return (
                          <td key={w} className={`px-2 py-2 text-center ${w === 0 ? 'bg-indigo-50/30' : ''}`}>
                            {short > 0.5 ? (
                              <>
                                <div className="font-semibold text-red-700">{Math.round(must)}f</div>
                                <div className="text-[10px] text-red-400">short {Math.round(short)}f / {Math.round(short * hpf)}h</div>
                              </>
                            ) : (
                              <div className="text-green-600 text-[10px]">on pace</div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── QUEUE & TURNAROUND TAB ──────────────────────────────────────── */}
          {activeTab === 'queue' && (
            <div className="space-y-6">
              <div className="bg-white border border-slate-100 rounded-xl p-5">
                <div className="flex items-start justify-between gap-2 flex-wrap mb-1">
                  <h2 className="text-sm font-semibold text-slate-700">Future turnaround — orders arriving each week</h2>
                  <InputModeToggle mode={queueUnit} onChange={setQueueUnit} unitLabel="Frames" />
                </div>
                <p className="text-xs text-slate-400 mb-4">
                  Estimated weeks from bouquet received to frame completed, including the fixed {PRESERVATION_WEEKS}-week preservation pipeline.
                  Add a hypothetical hire below to see how Planned turnaround responds, for that week and every week after.
                </p>
                {(() => {
                  const maxWeeksScale = Math.max(
                    ...hiringPlan.scheduledTurnaround.filter((t): t is number => t !== null),
                    ...hiringPlan.planTurnaround.filter((t): t is number => t !== null),
                    ...hiringPlan.scheduledTurnaroundTrend.filter((t): t is number => t !== null),
                    ...hiringPlan.planTurnaroundTrend.filter((t): t is number => t !== null),
                    DESIGN_TARGET_MAX,
                  ) * 1.05;
                  return (
                    <div className="overflow-x-auto -mx-1">
                      <table className="min-w-full text-xs border-separate" style={{ borderSpacing: 0 }}>
                        <thead>
                          <tr className="text-slate-400">
                            <th className="text-left font-medium px-2 py-1.5 sticky left-0 bg-white whitespace-nowrap">Week</th>
                            <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">Bouquets received</th>
                            <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">New hire</th>
                            <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">Design hours</th>
                            <th className="text-left font-medium px-2 py-1.5 min-w-[220px]">Turnaround</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hiringPlan.planTurnaround.map((total, w) => {
                            const schedTotal = hiringPlan.scheduledTurnaround[w];
                            const schedTrend  = hiringPlan.scheduledTurnaroundTrend[w];
                            const planTrend   = hiringPlan.planTurnaroundTrend[w];
                            // Color by the worse (higher) end of the range, not the optimistic
                            // as-scheduled number — a week that's only "ideal" if the team works
                            // full scheduled hours, but "large backlog" at the recent clocked
                            // pace, should read as the risk it actually is, not green.
                            const planWorst  = (total === null || planTrend === null) ? null : Math.max(total, planTrend);
                            const schedWorst = (schedTotal === null || schedTrend === null) ? null : Math.max(schedTotal, schedTrend);
                            // This total always includes the fixed PRESERVATION_WEEKS drying
                            // time, so it can structurally never go below that floor no matter
                            // how much capacity is scheduled — comparing it against
                            // DESIGN_TARGET_MIN (a design-only figure) made "overstaffed"
                            // unreachable. Landing exactly at the floor means the design queue
                            // isn't the bottleneck at all, which is the real overstaffed signal.
                            const overstaffed = planWorst !== null && planWorst <= PRESERVATION_WEEKS;
                            const schedOverstaffed = schedWorst !== null && schedWorst <= PRESERVATION_WEEKS;
                            // Once overstaffed, the real number just repeats PRESERVATION_WEEKS
                            // with no sense of degree — swap in the unclamped (drying-wait-free)
                            // figure so "overstaffed" can actually say how overstaffed, e.g. "6w".
                            const planUnclampedTotal  = hiringPlan.planTurnaroundUnclamped[w];
                            const planUnclampedTrend  = hiringPlan.planTurnaroundTrendUnclamped[w];
                            const planUnclampedWorst  = (planUnclampedTotal === null || planUnclampedTrend === null) ? null : Math.max(planUnclampedTotal, planUnclampedTrend);
                            const schedUnclampedTotal = hiringPlan.scheduledTurnaroundUnclamped[w];
                            const schedUnclampedTrend = hiringPlan.scheduledTurnaroundTrendUnclamped[w];
                            const schedUnclampedWorst = (schedUnclampedTotal === null || schedUnclampedTrend === null) ? null : Math.max(schedUnclampedTotal, schedUnclampedTrend);
                            const planDisplayWeeks  = overstaffed && planUnclampedWorst !== null ? planUnclampedWorst : planWorst;
                            const schedDisplayWeeks = schedOverstaffed && schedUnclampedWorst !== null ? schedUnclampedWorst : schedWorst;
                            const { bar, text, label } = turnaroundColors(planDisplayWeeks, overstaffed);
                            const schedColors = turnaroundColors(schedDisplayWeeks, schedOverstaffed);
                            const categoryOf = (l: string) => l.split('—')[1]?.trim() ?? l;
                            const weekIso = isoMonday(w);
                            const _weVal = weeklyEstimates[weekIso];
                            const hasOverride = _weVal !== undefined;
                            const overrideVal = hasOverride ? (location === 'Utah' ? _weVal.ut : _weVal.ga) : undefined;
                            const lastYearIso = addDays(weekIso, -364);
                            const lastYearActual = actualIntakeByWeek[lastYearIso];
                            const multiplier = getIntakeMultiplier(weekIso);
                            const projected = getProjectedIntake(weekIso);
                            const estVal = hasOverride ? overrideVal : (projected !== undefined ? projected : '');
                            const scheduledH = hiringPlan.scheduledHours[w];
                            const plannedH   = hiringPlan.plannedHours[w];
                            const hireCum    = hiringPlan.hireHoursByWeek[w];
                            const hpf = hiringPlan.hoursPerFrame[w] || 1;
                            const queueUnitLabel = queueUnit === 'output' ? 'f' : 'h';
                            const scheduledDisplay = queueUnit === 'output' ? round2(scheduledH / hpf) : Math.round(scheduledH);
                            const plannedDisplay   = queueUnit === 'output' ? round2(plannedH / hpf)   : Math.round(plannedH);
                            return (
                              <tr key={w} className={`border-b border-slate-50 align-top ${w % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                                <td className="px-2 py-2 sticky left-0 bg-inherit whitespace-nowrap text-slate-500">
                                  {getWeekLabel(w)}
                                  {w === 0 && <span className="ml-1 text-[9px] bg-indigo-100 text-indigo-600 rounded px-1">now</span>}
                                </td>
                                <td className="px-2 py-2">
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="number"
                                      value={estVal}
                                      placeholder={String(avgIntake)}
                                      min="0"
                                      onChange={e => setWeeklyEstimate(weekIso, parseInt(e.target.value) || 0)}
                                      className="w-14 border border-slate-200 rounded px-1.5 py-0.5 text-center text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300"
                                      title="Est. bouquets delivered this week"
                                    />
                                    <span className="text-[10px] text-slate-300">bq</span>
                                  </div>
                                  {lastYearActual !== undefined && (
                                    <div className="flex items-center gap-1 mt-0.5" title={`${lastYearActual} bq received ${fmtDate(lastYearIso)} (same week last year)`}>
                                      <span className="text-[10px] text-slate-400">×</span>
                                      <input
                                        type="number"
                                        step="0.1"
                                        min="0"
                                        value={multiplier}
                                        disabled={hasOverride}
                                        onChange={e => setWeeklyMultiplier(weekIso, parseFloat(e.target.value) || DEFAULT_INTAKE_MULTIPLIER)}
                                        className="w-12 border border-slate-200 rounded px-1 py-0.5 text-center text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 disabled:bg-slate-50 disabled:text-slate-300"
                                        title={hasOverride ? 'Clear the bq override to use the LY projection' : 'Multiplier applied to last year’s same week'}
                                      />
                                      <span className="text-[10px] text-slate-300">LY {lastYearActual}</span>
                                    </div>
                                  )}
                                </td>
                                <td className="px-2 py-2">
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="number" min="0" step="1" placeholder="0"
                                      value={settings.newHireHours[weekIso] ?? ''}
                                      onChange={e => setNewHireHours(weekIso, parseFloat(e.target.value) || 0)}
                                      className="w-14 border border-slate-200 rounded px-1.5 py-0.5 text-center text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-300"
                                      title="Hours/wk a hypothetical new hire starting this week would average"
                                    />
                                    <span className="text-[10px] text-slate-300">h/wk</span>
                                  </div>
                                  {hireCum > 0 && (
                                    <div className="text-[10px] text-emerald-600 mt-0.5 whitespace-nowrap">+{Math.round(hireCum)}h/wk running</div>
                                  )}
                                </td>
                                <td className="px-2 py-2 whitespace-nowrap">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-slate-400 w-14 shrink-0">Scheduled</span>
                                    <span className="text-slate-700 font-medium">{scheduledDisplay}{queueUnitLabel}</span>
                                  </div>
                                  <div className="flex items-center gap-1.5 mt-1">
                                    <span className="text-emerald-600 w-14 shrink-0">Planned</span>
                                    <span className="text-emerald-700 font-medium">{plannedDisplay}{queueUnitLabel}</span>
                                  </div>
                                </td>
                                <td className="px-2 py-2">
                                  <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] text-slate-400 w-14 shrink-0">Scheduled</span>
                                      {schedTotal !== null ? (
                                        <>
                                          <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                                            <div className={`h-2 rounded-full ${schedColors.bar}`} style={{ width: `${Math.min(100, ((schedDisplayWeeks ?? schedTotal) / maxWeeksScale) * 100)}%` }} />
                                          </div>
                                          <span className={`text-[10px] font-medium w-14 text-right shrink-0 ${schedColors.text}`}>{schedOverstaffed ? turnaroundRangeLabel(schedUnclampedTotal, schedUnclampedTrend) : turnaroundRangeLabel(schedTotal, schedTrend)}</span>
                                        </>
                                      ) : (
                                        <span className="text-[10px] text-red-500 italic">52wk+</span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] text-slate-400 w-14 shrink-0">Planned</span>
                                      {total !== null ? (
                                        <>
                                          <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                                            <div className={`h-2 rounded-full ${bar}`} style={{ width: `${Math.min(100, ((planDisplayWeeks ?? total) / maxWeeksScale) * 100)}%` }} />
                                          </div>
                                          <span className={`text-[10px] font-semibold w-14 text-right shrink-0 ${text}`}>{overstaffed ? turnaroundRangeLabel(planUnclampedTotal, planUnclampedTrend) : turnaroundRangeLabel(total, planTrend)}</span>
                                        </>
                                      ) : (
                                        <span className="text-[10px] text-red-600 italic">52wk+</span>
                                      )}
                                    </div>
                                  </div>
                                  {total !== null && (
                                    <div className={`text-[10px] mt-0.5 ${text}`}>{categoryOf(label)}</div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
                <div className="flex gap-4 mt-4 pt-3 border-t border-slate-100 flex-wrap">
                  <span className="text-[10px] text-slate-500">Design hours: Scheduled = the real Weekly Schedule. Planned = Scheduled + any new hire above — same numbers driving the Planned bar.</span>
                  <span className="text-[10px] text-slate-500 border-l border-slate-200 pl-4">Turnaround ranges reflect recent clocked-vs-scheduled hours.</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-slate-500 border-l border-slate-200 pl-4"><span className="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block" /> {PRESERVATION_WEEKS} wks (floor) — overstaffed</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" /> ≤10 wks ideal</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> ≤18 wks backlog building</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className="w-2.5 h-2.5 rounded-full bg-red-600 inline-block" /> &gt;18 wks large backlog</span>
                </div>
              </div>

              <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-100 flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-700">Weeks remaining until design — past intake cohorts</h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      For bouquets already received: estimated weeks from today until their cohort reaches the front of the FIFO design queue.
                      Based on {location} design backlog of {cohortIntake.remainingQueue.toLocaleString()} orders (from actual bouquets received) and scheduled capacity.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(() => {
                      const lastSentAt = Object.values(designPromises)
                        .map(p => p.lastConfirmedAt)
                        .sort()
                        .pop();
                      return lastSentAt ? (
                        <span className="text-[10px] text-slate-400 whitespace-nowrap" title="Most recent time a biweekly bloom update was locked in and sent">
                          Last sent: {new Date(lastSentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                      ) : null;
                    })()}
                    <button onClick={() => { loadBloomHistory(); setBloomHistoryOpen(true); }}
                      className="text-xs px-2.5 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 whitespace-nowrap">
                      Past bloom updates
                    </button>
                    <button onClick={() => setBloomModalOpen(true)}
                      className="text-xs px-2.5 py-1 border border-indigo-200 bg-indigo-50 rounded text-indigo-700 hover:bg-indigo-100 whitespace-nowrap"
                      title="Preview today's biweekly bloom update — locking it in makes it the client-facing promise. A promise can only get tighter over time, never later.">
                      Send biweekly bloom update
                    </button>
                    {(() => {
                      const doneCount = historicalRemaining.filter(row => 'alreadyDone' in row && row.alreadyDone).length;
                      return doneCount > 0 ? (
                        <button onClick={() => setShowDoneCohorts(v => !v)}
                          className="text-xs px-2.5 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 whitespace-nowrap">
                          {showDoneCohorts ? `Hide ${doneCount} completed ▲` : `Show ${doneCount} completed ▼`}
                        </button>
                      ) : null;
                    })()}
                  </div>
                </div>
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
                        {historicalRemaining.filter(row => showDoneCohorts || !('alreadyDone' in row && row.alreadyDone)).map((row, i) => {
                          const inPres    = 'inPreservation' in row && row.inPreservation;
                          const done      = 'alreadyDone'   in row && row.alreadyDone;
                          const weeksLeft = row.weeksFromNow;
                          const weeksElapsed = Math.round((getMondayDate(0).getTime() - new Date(row.weekOf + 'T12:00:00').getTime()) / (7 * 24 * 60 * 60 * 1000));
                          const totalToDesign        = (!done && weeksLeft !== null) ? weeksElapsed + weeksLeft : null;
                          const totalWithFulfillment = totalToDesign !== null ? totalToDesign + 2 : null;
                          // Received: same merged source as the "Bouquets received" row on the
                          // preservation Historicals tab — explicit presActuals override, else
                          // the team's logged order totals for that week, else hardcoded history.
                          const receivedVal = actualIntakeByWeek[row.weekOf] || null;
                          const receivedIsOverride = presActuals[row.weekOf] !== undefined;
                          // At risk: the live calc now points past a date we already promised
                          // a client. The live numbers above still show the true estimate —
                          // this is purely a flag that the promise needs attention.
                          const promise = designPromises[row.weekOf];
                          const atRisk = !done && weeksLeft !== null && !!promise
                            && addDays(isoMonday(0), weeksLeft * 7) > promise.promisedByDate;
                          return (
                            <tr key={i} className={`border-b border-slate-50 ${
                              done ? 'bg-slate-50 opacity-50' : inPres ? 'bg-green-50/30' : weeksLeft === 0 ? 'bg-indigo-50/40' : 'hover:bg-slate-50'
                            }`}>
                              <td className="px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                                {fmtDate(row.weekOf)}
                                {done && <span className="ml-2 text-[10px] bg-slate-200 text-slate-500 rounded px-1 py-px">✓ designed</span>}
                                {atRisk && (
                                  <span className="ml-2 text-[10px] bg-red-100 text-red-700 rounded px-1 py-px"
                                    title={`Promised by ${fmtDate(promise!.promisedByDate)} (~${promise!.promisedWeeks} wks when locked in) — currently trending later than that.`}>
                                    behind promise
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right text-slate-600">
                                {receivedVal === null ? '—' : receivedIsOverride
                                  ? <span className="text-green-700 font-medium">{receivedVal}</span>
                                  : <span className="text-indigo-400">{receivedVal}</span>}
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
                                    enters queue in ~{('preservationWeeksLeft' in row ? (row as {preservationWeeksLeft: number}).preservationWeeksLeft : 0)} wks,
                                    then ~{weeksLeft !== null ? weeksLeft - ('preservationWeeksLeft' in row ? (row as {preservationWeeksLeft: number}).preservationWeeksLeft : 0) : '?'} wks in design queue
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
                              <td className="px-3 py-2 text-center">
                                {totalToDesign !== null ? (
                                  <span className={`text-xs font-semibold ${totalToDesign <= 10 ? 'text-green-700' : totalToDesign <= 18 ? 'text-amber-700' : 'text-red-700'}`}>
                                    ~{totalToDesign} wks
                                  </span>
                                ) : done ? <span className="text-xs text-slate-300">—</span>
                                         : <span className="text-xs text-slate-400">TBD</span>}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {totalWithFulfillment !== null ? (
                                  <span className={`text-xs font-semibold ${totalWithFulfillment <= 12 ? 'text-green-700' : totalWithFulfillment <= 20 ? 'text-amber-700' : 'text-red-700'}`}>
                                    ~{totalWithFulfillment} wks
                                  </span>
                                ) : done ? <span className="text-xs text-slate-300">—</span>
                                         : <span className="text-xs text-slate-400">TBD</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
              </div>
            </div>
          )}

          {bloomModalOpen && (() => {
            const bloomRows: BloomUpdateRow[] = historicalRemaining
              .filter(r => !('alreadyDone' in r && r.alreadyDone) && r.weeksFromNow !== null)
              .map(r => ({ weekOf: r.weekOf, weeksUntilDesigned: r.weeksFromNow as number }));
            return (
              <BloomUpdateModal
                rows={bloomRows}
                location={location}
                onClose={() => setBloomModalOpen(false)}
                onConfirmed={loadDesignPromises}
              />
            );
          })()}
          {bloomHistoryOpen && (
            <BloomHistoryModal
              updates={bloomHistory}
              loading={bloomHistoryLoading}
              location={location}
              onClose={() => setBloomHistoryOpen(false)}
            />
          )}

          {/* ── MONTHLY SUMMARY TAB ─────────────────────────────────────────── */}
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

          {/* ── HISTORICALS TAB ─────────────────────────────────────────────── */}
          {activeTab === 'historicals' && (
            <>
              <HistoricalsSection
                department="design"
                location={location}
                members={designers.map(d => ({ id: d.id, name: d.name, payType: d.payType, hourlyRate: d.hourlyRate, annualSalary: d.annualSalary, excludeFromCPO: (d as {excludeFromCPO?:boolean}).excludeFromCPO }))}
                ordersLabel="frames"
                excludeFromCPONames={['Zac Williams', 'Lauren Boyd']}
              />
              <DisapprovalRateSection
                location={location}
                memberNames={designers.map(d => d.name)}
              />
            </>
          )}

        </>
      )}

      {/* ── MASTER SCHEDULE ─────────────────────────────────────────────────── */}
      {dept === 'payroll' && (
        <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-700">Rippling Payroll Upload</h3>
            <p className="text-xs text-slate-400 mt-0.5">Upload the &quot;Payroll Cost by Location and Department&quot; report from Rippling every two weeks. Data is stored securely and used only for accurate CPO calculations — pay details are never shown to team members.</p>
          </div>
          <div className="p-5">
            <RipplingUpload />
          </div>
        </div>
      )}

      {dept === 'resin' && (
        <>
        <DeptKPIBar dept="resin" location="Utah" kpiState={kpiMetrics} showCPO={hasAnyRates} />
        <ResinPage canViewCPO={canViewCPO} />
        </>
      )}
      {dept === 'master' && (
        <>
        <div className="bg-white border border-slate-100 rounded-xl p-4">
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className="text-xs font-medium text-slate-500">Paid holidays</span>
            <span className="text-[11px] text-slate-400">Shared across Utah &amp; Georgia — staff paid, zero production expected</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <input type="date" value={pendingHolidayDate} onChange={e => setPendingHolidayDate(e.target.value)}
              className="border border-slate-200 rounded px-2 py-1.5 text-sm text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
            <button onClick={() => { if (pendingHolidayDate) { addHoliday(pendingHolidayDate); setPendingHolidayDate(''); } }}
              disabled={!pendingHolidayDate}
              className="px-4 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Add
            </button>
          </div>
          {paidHolidays.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {paidHolidays.map(d => (
                <span key={d} className="inline-flex items-center gap-1.5 text-xs bg-slate-50 border border-slate-200 text-slate-600 px-2.5 py-1 rounded-full">
                  {new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  <button onClick={() => removeHoliday(d)} className="text-slate-400 hover:text-red-500 transition-colors">×</button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">No paid holidays set.</p>
          )}
        </div>
        <MasterScheduleSection
          location={location}
          masterAvailability={settings.masterAvailability}
          onAvailabilityChange={(a) => update('masterAvailability', a)}
          designHours={settings.designHours}
          designSchedule={schedule}
          presHours={settings.presHours}
          ffHours={settings.ffHours}
          resinHours={settings.resinHours}
          designRoster={settings.designRoster}
          presRoster={settings.presRoster}
          ffRoster={settings.ffRoster}
          ffDailyHours={settings.ffDailyHours}
          presDailyHours={settings.presDailyHours}
          resinRoster={Array.isArray(settings.resinRoster) ? settings.resinRoster as ResinMember[] : DEFAULT_RESIN_ROSTER}
          resinDailyHours={settings.resinDailyHours}
        />
        </>
      )}

    </div>
  );
}
