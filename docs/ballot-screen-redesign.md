# Ballot screen redesign: spec for implementation

Design canvas (3 phone frames, first is a clickable prototype): https://claude.ai/artifact/2YDXrSmnCJdDkbjDufzPBj

Replaces the old voter screen (region dropdown + "No region (2)" group + long bio cards + greyed "Cast vote"). Stack: React, Express, PostgreSQL. Voters are Umoja members signed in via Entra ID.

## Problems this fixes

1. No context: voter can't see what the campaign is, when it closes, or that the vote is anonymous.
2. "No region" heading leaks a database null; a region filter on a 2-candidate ballot is noise; orange focus ring on load looks like an error.
3. No clear selection state.
4. Disabled "Cast vote" with no reason shown.
5. Long bios cut off by the sticky footer.
6. One tap = irreversible vote, no review, no confirmation.

## Flow

1. Choose: pick one candidate.
2. Confirm: bottom sheet: chosen candidate, warning "Once you submit, your vote can't be changed.", "Submit my vote" (primary) / "Change my choice" (secondary).
3. Receipt: "Your vote is in", results date, receipt number (proves voting, never reveals the choice), "Done".

## Screen 1: Ballot

- Top bar: white, 1px #E3E7ED bottom border, padding 16px 20px. Logo 32px + app name 15px/600. Help icon button 44x44.
- Content: page bg #F5F7FA, padding 20px 20px 24px, scrolls.
- Eyebrow: "Step 1 of 2 · Choose": 13px/600, uppercase, letter-spacing 0.04em, navy, 6px below.
- Title: campaign question from the campaign record: 24px/700, line-height 1.25, 12px below.
- Chips: "Closes [end date/time]" (clock icon) and "Your vote is anonymous" (lock icon). Pill: white, 1px #D9DEE5, padding 6px 10px, 13px, #334155, icon 14px, gap 8px between chips, 16px below.
- Helper line: "Pick one candidate. You'll see your choice again before anything is submitted.": 15px, line-height 1.5, #4A5565, 16px below.
- Card list: vertical, 12px gap.
- Region filter: only above ~8 candidates. Never a "No region" group.

### Candidate card

- Container: white, 2px border, radius 16px, overflow hidden.
- Select area (real `<button>`, `aria-pressed`): column, centred, gap 12px, padding 24px 20px 20px, text centred.
- Photo: 96px circle, centred. Initials fallback 30px/700 on a soft tint.
- Name line: "Name – Region" on one centred line, wraps if long, 18px, line-height 1.3, gap 6px. Name 700 #0F1B2D; "– Region" 500 #4A5565. Omit "– Region" when null.
- Pledge: 15px, line-height 1.5, #1F2A3A, centred. Max 160 chars on card.
- Radio: absolute, top 14px right 14px, 24px circle, 2px border, white fill; selected shows a 12px navy dot.
- Footer row: 1px #D9DEE5 top border, centred "Read full statement ›" button, 44px tall, 14px/600 navy.
- Unselected: border #8A94A3, shadow 0 1px 2px rgba(15,27,45,.06), radio ring #6B7585.
- Selected: border #12355B, shadow 0 0 0 3px rgba(18,53,91,.18), bg #EEF3F9, radio ring navy + dot. Never colour alone.
- Compact variant (>6 candidates): photo left 52px, text left-aligned, pledge clamped to 2 lines.

### Sticky footer

- White, 1px #E3E7ED top border, padding 12px 20px 20px, gap 8px.
- None selected: disabled button (bg #E3E7ED, text #5B6575) "Review vote" + 13px #4A5565 "Select a candidate to continue".
- Selected: "Review vote for {first name}".
- On desktop, footer content width matches the card column.

### Confirm sheet

- Scrim rgba(15,27,45,.55). Sheet white, top radius 20px, padding 12px 20px 24px, gap 16px.
- Grab handle 40x4px #C9D0DA, centred.
- Eyebrow "Step 2 of 2 · Confirm" (same style as step 1), heading "Confirm your vote" 22px/700.
- Candidate row: bg #EEF3F9, 2px navy border, radius 14px, padding 16px, 52px photo + name 17px/600 + region/department 13px grey.
- Warning: bg #FFF6E5, text #6B4200, 14px, line-height 1.45, padding 12px 14px, radius 12px, warning icon 20px.
- Buttons: primary 52px navy; secondary 48px white, 1px #C9D0DA border, navy text. Both 16px/600, radius 12px.
- Focus trap, Escape closes, double-submit guard.

## Receipt

- White page. Centred stack, gap 16px, padding 32px 28px.
- Check icon in a 72px circle, bg #E6F2EB, icon #1E6B43.
- "Your vote is in" 24px/700; "Thank you for voting. Results will be shared on {date}." 15px #4A5565.
- Receipt box: bg #F5F7FA, 1px #E3E7ED, radius 12px, padding 14px 16px, left-aligned: label 13px grey, code 17px/600 letter-spacing .04em, note "Proves you voted. It doesn't show who you voted for." 13px grey.
- "Done" 52px primary in a bottom bar.

## Tokens

- Font Inter 400/500/600/700.
- Navy #12355B, text #0F1B2D, secondary #4A5565, body #1F2A3A, borders #D9DEE5 / #8A94A3 / #E3E7ED, page #F5F7FA, card #FFFFFF, selected fill #EEF3F9.
- Radius: cards 16, buttons 12, sheet 20 (top).
- Tap targets >= 44px; text WCAG AA.
- To match NamRA Connect, swap in official navy/orange; orange stays a subtle accent, never the primary button.

## Backend

- Campaign: question/title, close datetime, results-release date.
- Candidate: name, region (nullable), pledge (<=160), full statement, photo URL (nullable).
- One vote per voter + position, enforced by unique constraint in a transaction.
- Receipt code stored apart from the choice; no timestamp, serial or ordering that links it to a vote.
