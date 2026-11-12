import type pg from 'pg';
import { countResults, createGraphSearch, matchMembers, reportCsv, type MatchCounts, type MatchResult } from './match.js';
import { parseUmojaExport } from './parse.js';

export interface MatchJobDeps {
  fileText: string;
  token: string;                                  // in memory only
  /** Ignored: matching NEVER writes to a database (SEC-22). Kept so older callers keep compiling. */
  dryRun?: boolean;
  log: (line: string) => void;                    // PRIVACY: only ever called with counts, never a name, email or id
  writeReport: (csv: string) => void;             // the local report is the one place names/emails go
  /** Ignored, see dryRun. */
  connect?: () => Promise<pg.Client>;
  fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; graphBase?: string; ratePerSec?: number;
}

export interface MatchJobResult { counts: MatchCounts; results: MatchResult[] }

/**
 * Finds candidate Microsoft accounts for the members and writes the REVIEW REPORT. It does not touch the database: a person must
 * read the report, mark the rows they have checked with `yes`, and apply those separately (`--apply-confirmed`), because a name is
 * not an identity and a namesake would otherwise get a member's vote.
 */
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
  d.log('Local report written (names and emails are in the report file only). Nothing was written to any database.');
  d.log('Next: open the report, check each row, put "yes" in the confirm column of the rows that are right, then run');
  d.log('  npm run umoja:match -- --apply-confirmed <report file>');
  return { counts, results };
}
