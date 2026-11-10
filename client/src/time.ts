import { useEffect, useState } from 'react';

/** Re-renders every `ms` so countdowns stay fresh. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** "2d 4h", "3h 12m", "12m", "<1m". Returns null when already past. */
export function countdown(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - now.getTime();
  if (diff <= 0) return null;
  const m = Math.floor(diff / 60_000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return m > 0 ? `${m}m` : '<1m';
}

export const closesIn = (iso: string | null, now: Date): string | null => {
  const c = countdown(iso, now);
  return c ? `Closes in ${c}` : iso ? 'Closing now' : null;
};
