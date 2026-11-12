/**
 * SEC-21: user-supplied text (titles, descriptions, candidate names and bios, reasons, display names) is cleaned of characters
 * that change how text LOOKS without changing what it IS: bidirectional overrides and isolates (a name that renders reversed or
 * reordered), zero-width characters, other control characters and line/paragraph separators. React escapes HTML, so this is not an
 * XSS fix; it stops a candidate name or reason from being made to display as something else than what was stored.
 */

// Code point ranges to remove. Tab (9) and line feed (10) are kept here; cleanLine turns them into spaces itself.
//   0-8, 11-12, 14-31   C0 controls
//   127-159             DEL and the C1 controls
//   173                 soft hyphen
//   1564                Arabic letter mark
//   6158                Mongolian vowel separator
//   8203-8207           zero-width characters, left-to-right / right-to-left marks
//   8232-8233           line and paragraph separators
//   8234-8238           bidi embeddings and overrides
//   8288-8303           word joiner, invisible operators, bidi isolates, deprecated format characters
//   65279               byte order mark / zero-width no-break space
//   65529-65531         interlinear annotation characters
const RANGES: [number, number][] = [
  [0, 8], [11, 12], [14, 31], [127, 159], [173, 173], [1564, 1564], [6158, 6158], [8203, 8207], [8232, 8233],
  [8234, 8238], [8288, 8303], [65279, 65279], [65529, 65531],
];
const CHARS = RANGES.map(([a, b]) => (a === b ? String.fromCharCode(a) : String.fromCharCode(a) + '-' + String.fromCharCode(b))).join('');
const INVISIBLE = new RegExp('[' + CHARS + ']', 'g');

/** One line: invisible characters removed, tabs and line breaks become a space, runs of spaces collapse, NFC-normalised. */
export const cleanLine = (s: string): string => s.normalize('NFC').replace(INVISIBLE, '').replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ');

/** Several lines (descriptions, bios, reasons): same, but new lines and tabs are kept (CRLF becomes LF). */
export const cleanMultiline = (s: string): string => s.normalize('NFC').replace(INVISIBLE, '').replace(/\r\n?/g, '\n');
