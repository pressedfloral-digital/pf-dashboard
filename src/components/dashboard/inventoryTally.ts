// Material tallies shared by the Inventory views (the Design schedule and
// designed-but-not-shipped pieces).
import { NOT_ON_ORDER, ADDONS_UNKNOWN, sizeLabel, type QueueLine } from '@/lib/designInventory';

export type Material = 'frame' | 'backing' | 'glass';

export const MATERIALS: { id: Material; label: string; typeLabel: string }[] = [
  { id: 'frame',   label: 'Frames',  typeLabel: 'Moulding / Color' },
  { id: 'backing', label: 'Backing', typeLabel: 'Backing' },
  { id: 'glass',   label: 'Glass',   typeLabel: 'Glass type' },
];

export const STATUS_LABELS: Record<string, string> = {
  readyToFrame:       'Ready to Frame',
  readyToDesign:      'Ready to Design',
  bouquetReceived:    'Bouquet Received',
  checkedOn:          'Checked On',
  progress:           'In Progress',
  almostReadyToFrame: 'Almost Ready to Frame',
  frameCompleted:     'No Response',
  frameApproved:      'Approved',
  approved:           'Approved',
  disapproved:        'Disapproved',
  frameDisapproved:   'Disapproved',
  glued:              'Glued',
  readyToSeal:        'Ready to Seal',
  readyToPackage:     'Ready to Package',
  readyToShip:        'Ready to Ship',
  readyToFulfill:     'Ready to Fulfill',
  preparingToBeShipped: 'Preparing to Ship',
};

// "Not on order" (the order has none) and "Couldn't load" (unknown) must
// never look alike.
export function materialClass(v: string | null | undefined): string {
  if (v === ADDONS_UNKNOWN) return 'text-rose-600 font-medium';
  if (v === NOT_ON_ORDER) return 'text-amber-600';
  return 'text-slate-700';
}

// One countable item per line for a material, or null when the line's
// product doesn't use it (ornaments have no backing/glass).
export function itemFor(l: QueueLine, m: Material): { size: string; shape: string; type: string } | null {
  const size = l.materials?.sizeLabel ?? sizeLabel(l);
  const shape = l.shape || '—';
  if (m === 'frame') return { size, shape, type: l.finish || '—' };
  const type = m === 'backing' ? l.materials?.backing : l.materials?.glass;
  if (type === null) return null;
  return { size, shape, type: type ?? NOT_ON_ORDER };
}

// Smallest frame first, then non-sized products (Boutonniere, Custom…) by name.
function sizeOrder(s: string): [number, number, string] {
  const m = s.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  return m ? [0, Number(m[1]) * Number(m[2]), s] : [1, 0, s];
}
export function bySize(a: string, b: string): number {
  const [ga, na, sa] = sizeOrder(a), [gb, nb, sb] = sizeOrder(b);
  return ga - gb || na - nb || sa.localeCompare(sb);
}

export interface Row { size: string; shape: string; type: string; byWeek: Record<string, number>; total: number }

export function tally(weeks: { weekOf: string; lines: QueueLine[] }[], m: Material): Row[] {
  const map = new Map<string, Row>();
  weeks.forEach(w => w.lines.forEach(l => {
    const it = itemFor(l, m);
    if (!it) return;
    const k = `${it.size}|${it.shape}|${it.type}`;
    const row = map.get(k) ?? { ...it, byWeek: {}, total: 0 };
    row.byWeek[w.weekOf] = (row.byWeek[w.weekOf] ?? 0) + 1;
    row.total++;
    map.set(k, row);
  }));
  return [...map.values()].sort((a, b) => bySize(a.size, b.size) || b.total - a.total || a.type.localeCompare(b.type));
}

