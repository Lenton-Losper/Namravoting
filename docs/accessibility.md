# Accessibility (WCAG 2.1 AA) and poor signal

## What is checked automatically (runs in CI with every change)
- **axe-core** over the real pages with the real header, navigation and dialogs: sign-in, My votes, the ballot (with an Abstain line, a withdrawn
  candidate and the confirmation dialog), published results (tie and quorum warning), the admin dashboard, create and edit campaign, every tab of the
  campaign page and its dialogs, and the observer page. Rules: WCAG 2.0 A and AA, 2.1 A and AA, plus axe's best-practice rules. (`client/src/a11y.test.tsx`)
- **Colour contrast** computed from the stylesheet tokens, because jsdom cannot do it: text pairs at 4.5:1; form-field borders and the keyboard focus
  ring at 3:1. (`client/src/contrast.test.ts`)
- Keyboard and screen-reader basics: a "Skip to main content" link as the first tab stop, one `main` landmark, labelled navigation, the logo's alt text,
  and dialogs announced as modal with a name that Escape closes.

## What the first pass found and fixed
- Secondary text (`--muted`) was 4.2:1 on tinted backgrounds: darkened to #5B6673 (5.3:1 or better everywhere).
- Form-field borders were 1.3:1 against the page: now the muted colour (5.9:1).
- The keyboard focus ring was the brand orange (2.6:1 on white): now a darker orange with a white halo, so it also shows on the navy bar.
- The ballot's candidate list was a `ul role="radiogroup"` with `li` children (invalid list semantics for screen readers): now a plain `radiogroup`.
- There was no skip link: added.

## Poor signal
- If a vote's answer never arrives, the page asks the server whether the vote landed. If the server cannot be reached to check, it says
  **"Your vote may not have been recorded"**, removes the ballot (so it cannot be pressed twice in panic) and offers "Check again" and "My votes".
  If the check shows the vote landed: "You have already voted". If it shows no receipt: "Your vote was not recorded. You can vote again."
- A plain "You appear to be offline" notice appears while the browser has no connection.
- Reads already retry quietly while the container wakes up. A re-sign-in after an expired session keeps the selection (see `operations.md`).

## Not covered by automation: please have a person check
- A real **screen-reader pass** (NVDA or JAWS on Windows, VoiceOver on a phone) through sign-in, voting and the admin screens.
- **Large text and zoom:** text sizes are fixed pixel sizes (body 14px), so browser zoom and page zoom work and layout reflows, but changing the browser's *default font size*
  does not scale the text. Converting to relative sizes is a design-wide change that was not made.
- **Touch targets, motion and focus order on real devices.**
- Plain-language review of the wording.

## Decision needed: an external accessibility review?
Recommended before the first real election, because staff with disabilities are among the people who must be able to vote unaided. The automated
checks above catch the mechanical problems (they found five), not whether the flow makes sense to someone using a screen reader. A one-day review by a
specialist is a modest cost for a vote the organisation will rely on.
