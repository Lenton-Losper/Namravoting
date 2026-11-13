/**
 * Who is in the running, and whether first place is tied. Pure, so the same rule is used by the results page, the exports, the
 * dashboard and the run-off. Abstain lines and withdrawn candidates are never contenders (they cannot win and cannot tie).
 */
export interface Counted { id: string; name: string; votes: number; is_abstain?: boolean; withdrawn?: boolean }

export const isContender = (c: Counted): boolean => !c.is_abstain && !c.withdrawn;

export interface Standing { leader: Counted | null; tied: Counted[] }

/** `tied` has 2 or more candidates sharing the most votes (and that number is above zero); `leader` is the single winner otherwise. */
export function standing(cands: Counted[]): Standing {
  const live = cands.filter(isContender);
  const top = Math.max(0, ...live.map((c) => c.votes));
  if (top === 0) return { leader: null, tied: [] };
  const first = live.filter((c) => c.votes === top);
  return first.length > 1 ? { leader: null, tied: first } : { leader: first[0], tied: [] };
}
