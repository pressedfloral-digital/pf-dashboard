// Single source of truth for "bouquets received (intake)" history, shared
// between SchedulePage.tsx's per-location Queue & Turnaround tab and the
// company-wide Growth & Distribution tab. Extracted so both consumers read
// the exact same seed data and merge logic instead of maintaining two
// copies that can drift apart (see commits 235736f / faa64aa, which had to
// fix exactly that kind of drift between two near-identical calculators).

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// Default projection ratio for auto-filled "bouquets received" estimates:
// same week last year × this multiplier. Editable per week.
export const DEFAULT_INTAKE_MULTIPLIER = 1.2;

// First week team_member_week_actuals has live preservation data, for both
// locations. The historical seed arrays below run a bit past this date
// (through 2026-06-29) — a leftover overlap from before live tracking
// existed. Kept as-is rather than trimmed, so the old data isn't lost, but
// computeActualIntakeByWeek must ignore the seed value for any week on/after
// this date so it can't get added on top of the live total for that week.
export const LIVE_INTAKE_TRACKING_START = '2025-12-29';

export const UTAH_HISTORICAL_INTAKE: { weekOf: string; actual: number }[] = [
  { weekOf: '2025-04-21', actual: 133   },
  { weekOf: '2025-04-28', actual: 117   },
  { weekOf: '2025-05-05', actual: 88    },
  { weekOf: '2025-05-12', actual: 112   },
  { weekOf: '2025-05-19', actual: 182   },
  { weekOf: '2025-05-26', actual: 160   },
  { weekOf: '2025-06-02', actual: 180   },
  { weekOf: '2025-06-09', actual: 153   },
  { weekOf: '2025-06-16', actual: 192   },
  { weekOf: '2025-06-23', actual: 173   },
  { weekOf: '2025-06-30', actual: 61    },
  { weekOf: '2025-07-07', actual: 27    },
  { weekOf: '2025-07-14', actual: 120   },
  { weekOf: '2025-07-21', actual: 93    },
  { weekOf: '2025-07-28', actual: 84    },
  { weekOf: '2025-08-04', actual: 110   },
  { weekOf: '2025-08-11', actual: 119   },
  { weekOf: '2025-08-18', actual: 108   },
  { weekOf: '2025-08-25', actual: 124   },
  { weekOf: '2025-09-01', actual: 120   },
  { weekOf: '2025-09-08', actual: 146   },
  { weekOf: '2025-09-15', actual: 154   },
  { weekOf: '2025-09-22', actual: 146.5 },
  { weekOf: '2025-09-29', actual: 186.5 },
  { weekOf: '2025-10-06', actual: 167   },
  { weekOf: '2025-10-13', actual: 192   },
  { weekOf: '2025-10-20', actual: 159   },
  { weekOf: '2025-10-27', actual: 139   },
  { weekOf: '2025-11-03', actual: 97    },
  { weekOf: '2025-11-10', actual: 110   },
  { weekOf: '2025-11-17', actual: 68    },
  { weekOf: '2025-11-24', actual: 39    },
  { weekOf: '2025-12-01', actual: 15    },
  { weekOf: '2025-12-08', actual: 29    },
  { weekOf: '2025-12-15', actual: 41    },
  { weekOf: '2025-12-22', actual: 16    },
  { weekOf: '2025-12-29', actual: 24    },
  { weekOf: '2026-01-05', actual: 22    },
  { weekOf: '2026-01-12', actual: 18    },
  { weekOf: '2026-01-19', actual: 22    },
  { weekOf: '2026-01-26', actual: 12    },
  { weekOf: '2026-02-02', actual: 10    },
  { weekOf: '2026-02-09', actual: 25    },
  { weekOf: '2026-02-16', actual: 27    },
  { weekOf: '2026-02-23', actual: 24    },
  { weekOf: '2026-03-02', actual: 13    },
  { weekOf: '2026-03-09', actual: 28    },
  { weekOf: '2026-03-16', actual: 47    },
  { weekOf: '2026-03-23', actual: 43    },
  { weekOf: '2026-03-30', actual: 43    },
  { weekOf: '2026-04-06', actual: 49    },
  { weekOf: '2026-04-13', actual: 71    },
  { weekOf: '2026-04-20', actual: 66    },
  { weekOf: '2026-04-27', actual: 120   },
  { weekOf: '2026-05-04', actual: 85    },
  { weekOf: '2026-05-11', actual: 68    },
  { weekOf: '2026-05-18', actual: 148   },
  { weekOf: '2026-05-25', actual: 115   },
  { weekOf: '2026-06-01', actual: 104   },
  { weekOf: '2026-06-08', actual: 117   },
  { weekOf: '2026-06-15', actual: 129   },
  { weekOf: '2026-06-22', actual: 150   },
  { weekOf: '2026-06-29', actual: 155   },
];

// ─── Historical Georgia intake (actual received by week) ──────────────────────
export const GEORGIA_HISTORICAL_INTAKE: { weekOf: string; actual: number }[] = [
  { weekOf: '2025-04-21', actual: 104 },
  { weekOf: '2025-04-28', actual: 114 },
  { weekOf: '2025-05-05', actual: 71  },
  { weekOf: '2025-05-12', actual: 134 },
  { weekOf: '2025-05-19', actual: 125 },
  { weekOf: '2025-05-26', actual: 176 },
  { weekOf: '2025-06-02', actual: 166 },
  { weekOf: '2025-06-09', actual: 123 },
  { weekOf: '2025-06-16', actual: 169 },
  { weekOf: '2025-06-23', actual: 107 },
  { weekOf: '2025-06-30', actual: 64  },
  { weekOf: '2025-07-07', actual: 104 },
  { weekOf: '2025-07-14', actual: 76  },
  { weekOf: '2025-07-21', actual: 91  },
  { weekOf: '2025-07-28', actual: 91  },
  { weekOf: '2025-08-04', actual: 91  },
  { weekOf: '2025-08-11', actual: 91  },
  { weekOf: '2025-08-18', actual: 86  },
  { weekOf: '2025-08-25', actual: 115 },
  { weekOf: '2025-09-01', actual: 108 },
  { weekOf: '2025-09-08', actual: 156 },
  { weekOf: '2025-09-15', actual: 133 },
  { weekOf: '2025-09-22', actual: 167 }, // wk 39
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
  { weekOf: '2026-03-30', actual: 56  }, // wk 14
  { weekOf: '2026-04-06', actual: 8   },
  { weekOf: '2026-04-13', actual: 36  },
  { weekOf: '2026-04-20', actual: 57  },
  { weekOf: '2026-04-27', actual: 89  },
  { weekOf: '2026-05-04', actual: 73  },
  { weekOf: '2026-05-11', actual: 75  },
  { weekOf: '2026-05-18', actual: 112 },
  { weekOf: '2026-05-25', actual: 106 },
  { weekOf: '2026-06-01', actual: 138 },
  { weekOf: '2026-06-08', actual: 124 },
  { weekOf: '2026-06-15', actual: 139 },
  { weekOf: '2026-06-22', actual: 151 },
  { weekOf: '2026-06-29', actual: 135 },
];

// Earliest week either location has real intake data for — lets the Growth &
// Distribution tab's Company Total table show its full available history
// instead of a fixed trailing-8-weeks window, without hardcoding a week
// count that would need updating as the seed arrays above grow.
export const EARLIEST_HISTORICAL_WEEK = [UTAH_HISTORICAL_INTAKE[0]?.weekOf, GEORGIA_HISTORICAL_INTAKE[0]?.weekOf]
  .filter((w): w is string => !!w)
  .sort()[0];

export type TeamActualRow = { department: string; week_of: string; member_name: string; actual_hours: number; actual_orders: number };

// Merged (hardcoded historical < team actuals < Supabase preservation actuals) —
// single source of truth for "what actually came in a given week" for one
// location, used both to graduate the preservation queue and to look up
// same-week-last-year for projecting future intake.
export function computeActualIntakeByWeek(
  location:    'Utah' | 'Georgia',
  teamActuals: TeamActualRow[],
  presActuals: Record<string, number>,
): Record<string, number> {
  const map: Record<string, number> = {};
  const hardcoded = location === 'Utah' ? UTAH_HISTORICAL_INTAKE : GEORGIA_HISTORICAL_INTAKE;
  hardcoded.forEach(h => {
    if (h.weekOf < LIVE_INTAKE_TRACKING_START) map[h.weekOf] = h.actual;
  });
  const liveByWeek: Record<string, number> = {};
  teamActuals.filter(r => r.department === 'preservation').forEach(r => {
    liveByWeek[r.week_of] = (liveByWeek[r.week_of] ?? 0) + r.actual_orders;
  });
  Object.entries(liveByWeek).forEach(([weekOf, val]) => { map[weekOf] = val; });
  Object.entries(presActuals).forEach(([weekOf, val]) => { map[weekOf] = val; });
  return map;
}

// Company-wide (Utah + Georgia) actual intake by week — only counts a week
// where at least one location has data, so a week neither location has
// reported yet stays undefined rather than reading as a false 0.
export function computeCombinedIntakeByWeek(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const map: Record<string, number> = {};
  const weeks = new Set([...Object.keys(a), ...Object.keys(b)]);
  weeks.forEach(w => {
    if (a[w] === undefined && b[w] === undefined) return;
    map[w] = (a[w] ?? 0) + (b[w] ?? 0);
  });
  return map;
}

// Rolling default growth multiplier: the average realized multiplier (actual
// intake ÷ same week last year) across the 4 most recent ACTUAL weeks that
// have both sides of that comparison. Recomputes automatically as new actual
// weeks land; DEFAULT_INTAKE_MULTIPLIER is only the fallback for when there
// isn't yet enough realized history to average (e.g. a new market).
export function computeRollingMultiplier(actualIntakeByWeek: Record<string, number>, isoMonday: (offsetWeeks: number) => string): number {
  const ratios: number[] = [];
  for (let w = -1; w >= -104 && ratios.length < 4; w--) {
    const weekOf = isoMonday(w);
    const actual = actualIntakeByWeek[weekOf];
    if (actual === undefined) continue;
    const lastYear = actualIntakeByWeek[addDays(weekOf, -364)];
    if (lastYear === undefined || lastYear <= 0) continue;
    ratios.push(actual / lastYear);
  }
  return ratios.length > 0 ? ratios.reduce((s, r) => s + r, 0) / ratios.length : DEFAULT_INTAKE_MULTIPLIER;
}
