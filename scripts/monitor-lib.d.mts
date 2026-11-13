export interface Check { name: string; ok: boolean; warn?: boolean; detail: string }
type Fetch = typeof fetch;
export function checkApp(base: string, opts?: { fetchImpl?: Fetch; sleep?: (ms: number) => Promise<void>; retries?: number; delayMs?: number }): Promise<Check[]>;
export function summarise(checks: Check[]): { lines: string[]; failing: Check[]; warning: Check[]; ok: boolean };
export function sendAlert(webhook: string | undefined, title: string, lines: string[], opts?: { fetchImpl?: Fetch }): Promise<boolean>;
