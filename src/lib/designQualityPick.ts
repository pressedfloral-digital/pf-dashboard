/** Random frame picking for Design Quality — pure, so it's unit-tested. */
import { randomInt } from 'crypto';

export interface PickCandidate {
  orderNum: string;
  orderProductUuid: string;
}

/** Fisher–Yates shuffle with the crypto RNG (or an injected one, in tests). */
export function shuffle<T>(items: T[], rand: (n: number) => number = randomInt): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

/**
 * Picks `need` random frames a designer doesn't already have picked. Frames
 * from an order that's already picked come last: an order with two frames
 * on it would otherwise show the grader the same order number twice. Those
 * are only used when the designer has no other frames left.
 */
export function choosePicks<T extends PickCandidate>(
  candidates: T[],
  existing: PickCandidate[],
  need: number,
  rand?: (n: number) => number,
): T[] {
  if (need <= 0) return [];
  const takenProducts = new Set(existing.map(p => p.orderProductUuid));
  const pool = shuffle(candidates.filter(f => !takenProducts.has(f.orderProductUuid)), rand);
  const orders = new Set(existing.map(p => p.orderNum));
  const picks: T[] = [];
  for (const f of pool) {
    if (picks.length >= need) break;
    if (!orders.has(f.orderNum)) { picks.push(f); orders.add(f.orderNum); }
  }
  for (const f of pool) {
    if (picks.length >= need) break;
    if (!picks.includes(f)) picks.push(f);
  }
  return picks;
}
