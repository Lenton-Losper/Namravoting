import type pg from 'pg';
import { applyMatches, countResults, createGraphSearch, matchMembers, reportCsv, type ApplySummary, type MatchCounts, type MatchResult } from './match.js';
import { parseUmojaExport } from './parse.js';

export interface MatchJobDeps {
  fileText: string;
  token: string;                                  // in memory only
  dryRun: boolean;
  log: (line: string) => void;                    // PRIVACY: only ever called with counts, never a name, email or id
  writeReport: (csv: string) => void;             // the local report is the one place names/emails go
  connect?: () => Promise<pg.Client>;             // owner-role connection, only used when not a dry run
  fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; graphBase?: string; ratePerSec?: number;
}

export interface MatchJobResult { counts: MatchCounts; applied?: ApplySummary; results: MatchResult[] }

export async function runMatchJob(d: MatchJobDeps): Promise<MatchJobResult> {
  const parsed = parseUmojaExport(d.fileText, { keepNames: true });
  const members = parsed.members.filter((m) => m.name);
  d.log(`Members read: ${parsed.members.length} (${members.length} with a name to look up)`);
  const search = createGraphSearch({ token: d.token, fetch: d.fetch, sleep: d.sleep, now: d.now, graphBase: d.graphBase, ratePerSec: d.ratePerSec });
  const results = await matchMembers(members, search, (done, total) => { if (done % 250 === 0 && done < total) d.log(`Looked up ${done}/${total}`); });
  d.writeReport(reportCsv(results));
  const counts = countResults(results);
  d.log(`matched: ${counts.matched}`);
  d.log(`not_found: ${counts.not_found}`);
  d.log(`ambiguous: ${counts.ambiguous}`);
  d.log(`conflict: ${counts.conflict}`);
  d.log('Local report written (names and emails are in the report file only).');
  if (d.dryRun) { d.log('Dry run: nothing was written to any database.'); return { counts, results }; }
  if (!d.connect) throw new Error('A database connection is required when not running with --dry-run');
  const client = await d.connect();
  try {
    const applied = await applyMatches(client, results);
    d.log(`Updated ${applied.updated} members (${applied.not_in_db} matched codes were not in the table). Audit entry "umoja.match" written (counts only).`);
    return { counts, applied, results };
  } finally { await client.end(); }
}
