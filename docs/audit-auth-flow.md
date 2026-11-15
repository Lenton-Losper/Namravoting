# Audit: sign-in, redirects and role separation (15 Nov 2026)

Scope: every way a person reaches the app signed out, signs in, and where they land; what each role can reach; the nomination form
(`/n/<token>`) and the admin position cards. Live sign-in mode at the time: `AUTH_MODE=email-demo` (the same redirect rules apply to
Microsoft sign-in, `AUTH_MODE=entra`). Each finding names what happened, what should happen, its severity and the fix (commit on `main`).

Severity: **High** = a person ends up in the wrong place or sees data they should not; **Medium** = a real usability or accessibility
problem; **Low** = polish.

## 1. The pieces

| Piece | Where | What it does |
|---|---|---|
| Route guard | `client/src/App.tsx` `RequireUser` | Signed out: `Navigate` to `/login?next=<path + query>`. `RequireUser admin`, signed in but not an admin: a "Not allowed" card with a link to My votes. |
| Home | `App.tsx` `Home` (`/`) | Signed out: `/login` (no `next`). Signed in: `/admin` for admins, `/votes` for everyone else. |
| Sign-in page | `client/src/pages/Login.tsx` | Picks the page by `authMode`: `EmailSignIn` (email-demo), `MicrosoftSignIn` (entra), `AccessSignIn` (demo), `DevPicker` (dev). Each one, once a user exists, goes to the landing page (below). |
| Email sign-in | `server/src/auth/emailDemoAuth.ts`, `POST /api/email-login` | Creates the database session. No server redirect: the client chooses where to go. |
| Microsoft sign-in | `server/src/auth/entra.ts`, `/auth/login?next=` -> Microsoft -> `/auth/callback` | `next` is checked on the server, kept in the per-attempt cookie, and used for the redirect after the callback. |
| 401 handler | `client/src/api.ts` `sessionExpired` | Any 401 from the API: forget the user, then `/login?expired=1&next=<current page>`. |
| `safeNext` | `client/src/safeNext.ts` and `server/src/auth/safeNext.ts` (kept identical by a test) | Accepts only same-site relative paths under an allow-list; anything else is ignored (open-redirect protection). |
| `landingFor` (new) | same two files | One rule for "where do I go after signing in": the safe `next`, else the role default; never an `/admin` page for a non-admin. |

## 2. Every entry point: where a signed-out person ends up after signing in

The person opens the page signed out. `RequireUser` (or Home) sends them to `/login?next=<page>`. They sign in. The table shows where
they ended up **before** the fixes, and where they end up now.

| # | Entry point | Admin: before | Admin: now | Non-admin: before | Non-admin: now | Finding |
|---|---|---|---|---|---|---|
| 1 | `/v/<token>` (ballot link / QR) | `/v/<token>` | `/v/<token>` | `/v/<token>` | `/v/<token>` | Correct. |
| 2 | **`/n/<token>` (nomination link / QR)** | **`/admin`** | `/n/<token>` | **`/votes`** | `/n/<token>` | **F1 (High).** `/n/` was not in the `safeNext` allow-list, so `next` was thrown away and the candidate landed on the dashboard or My votes, without the form they came for. |
| 3 | `/votes` | `/votes` | `/votes` | `/votes` | `/votes` | Correct. |
| 4 | `/observe`, `/observe/<id>` | same page | same page | same page | same page | Correct (observers are usually not admins). |
| 5 | `/admin`, `/admin/c/<id>?tab=…` | same page | same page | **same page -> "Not allowed"** | `/votes` | **F2 (Medium).** A non-admin was sent to an admin page only to be told "Not allowed". The server never returned data (see §3), but it is a dead end. |
| 6 | `/` (Home) | `/admin` | `/admin` | `/votes` | `/votes` | Correct. |
| 7 | `/login` opened directly | `/admin` | `/admin` | `/votes` | `/votes` | Correct. |
| 8 | `/login?next=https://evil…` or `//evil…` | `/admin` | `/admin` | `/votes` | `/votes` | Correct: the outside address is ignored. |
| 9 | `/login?next=/n/<token>`, already signed in | **`/admin`** | `/n/<token>` | **`/votes`** | `/n/<token>` | Same as F1. |
| 10 | Session ends (401) on `/n/<token>` | after re-sign-in **`/admin`** | `/n/<token>` | **`/votes`** | `/n/<token>` | Same as F1: the 401 handler also filtered `next` through `safeNext`. |
| 11 | Session ends (401) on `/v/`, `/votes`, `/admin/c/…` | same page | same page | same page (admin page: see F2) | same page / `/votes` | Correct; F2 for admin pages. |
| 12 | Microsoft sign-in (`entra`) from any of the above | the same as rows 1 to 10 | | | | The server copy of `safeNext` had the same gaps (F1, F2); fixed with the same `landingFor`. |
| 13 | Sign out, then the next person signs in on the same device | **the previous person's page** | `/login` -> role default | **the previous person's page** | `/login` -> role default | **F3 (Low).** In dev and email-demo, signing out left the browser on the current page, so the guard put that page in `next` and the next person landed there. Signing out now starts on a clean `/login`. |

What should happen, in one rule (`landingFor`): **come back to the exact ballot or nomination link; otherwise the page you came from if
your role may see it; otherwise `/admin` for admins and `/votes` for everyone else; never an outside address.**

## 3. Role separation

Roles: **admin** (campaign administrator; for a given campaign, its creator or a co-admin), **plain voter** (any other signed-in
person), **candidate** (a voter who has nominated themselves; no extra rights), **observer** (read-only on campaigns they were added to).

| Area | Admin (own campaign) | Admin (someone else's campaign) | Voter / candidate | Checked |
|---|---|---|---|---|
| Admin screens `/admin/*` | yes | yes (their own campaigns only) | "Not allowed" card; no admin API is called | client test |
| `/api/campaigns/mine`, `/summary` | own campaigns only | own campaigns only | **403** | server test |
| `/api/campaigns/:id` and everything under it: positions, regions, nominations, invite QR, results, verify, team (incl. approvals), notify, late voters, CSV/Excel/PDF/bundle, QR, poster | yes | **404** (ids are not confirmed; the attempt is audited) | **403** | server test, every route listed |
| Admin actions (create, start, approve, …) | yes | 404 | **403** | server test |
| My votes `/api/vote` | own votes | own votes | open votes they may vote in, and published results; **never drafts, never unpublished results** | server test |
| Ballot of a draft `/api/vote/<token>` | — | — | title only: **no positions, no candidates** | server test |
| Results `/api/vote/<token>/results` | — | — | only once **published** (404 before) | server test |
| Nomination page `/api/nominate/<token>` | — | — | the position, the regions and **only the caller's own profile**; never another nominee's name, bio, status or photo | server test |
| Candidate photos `/api/photos/<id>` | yes | 404 | own photo always; others' only once the campaign has started **and** the candidate is approved | server test |
| Observer pages `/api/observe/*` | only if added as observer | | only if added as observer | existing tests |

**Finding: none.** No admin data reaches a non-admin: every admin route is behind the admin-role gate (403) and, for an admin, behind the
per-campaign owner/co-admin gate (404). The nomination API returns only rows where `submitted_by_oid` is the caller. Server-side checks
are the authority; the client guards are only for a sensible screen.

Noted, by design (no change): a nomination link (`/n/<token>`) shows the campaign title and position title to any signed-in person who
may nominate and holds the link; that is what the link is for. In email-demo anyone can sign in as any NamRA address (see
`docs/operations.md`); that weakens identity, not role separation.

## 4. The nomination form (`/n/<token>`)

| # | Finding | Severity | Fix |
|---|---|---|---|
| F4 | Help text and the bio character counter sat **inside** each `<label>`, so they became part of the field's accessible name; the counter changed the bio field's name on every keystroke. | Medium | Each field now has a short label, its help in a separate paragraph linked by `aria-describedby`, and the counter in its own polite live region. |
| F5 | No guidance on what to write: no placeholders, vague help ("Where you work."). | Medium | Name: help "Your full name as colleagues know you, e.g. Maria Shikongo", placeholder "First name and surname". Bio: help "2–4 sentences: your role, your experience, and what you'll do if elected. Max 500 characters." with an example placeholder. Photo: "A clear, recent head-and-shoulders photo. JPG or PNG, max 2 MB." Region: "The region where you're based." |
| F6 | Required fields were not marked. | Low | Name and Region marked "*", with "Fields marked * are required." at the top. |
| F7 | The label read "Display name" (system wording). | Low | Now "Name". |

## 5. The admin position cards

| # | Finding | Severity | Fix |
|---|---|---|---|
| F8 | The reorder buttons were bare "↑" / "↓" glyphs with no tooltip; sighted users had to guess. | Medium | `title` and accessible name "Move up" / "Move down", described by the card's heading (a screen reader hears "Move up, Press Secretary"). |
| F9 | "Manage" / "View" had the same name on every card, with nothing to tell them apart for a screen-reader user. | Low | Described by the card's heading. |

## 6. Tests

- `client/src/signInPaths.test.tsx`: every row of the table in §2, for an admin and a non-admin, through the real router, guards and
  email sign-in page; the 401 redirect from each page; sign-out; "Not allowed" fetches no admin data. With the `/n/` fix removed, the 4
  nomination cases fail.
- `server/tests/unit/safeNext.test.ts`: `/n/` accepted, `/n` and look-alikes and backslash/protocol-relative tricks rejected, and the
  `landingFor` table.
- `server/tests/integration/entra.test.ts`: Microsoft sign-in returns to `/n/<token>` for both roles; a non-admin is sent to `/votes`, not
  `/admin/...`.
- `server/tests/integration/roleSeparation.test.ts`: §3, every admin route for a voter, a candidate and an admin of another campaign;
  the nomination API and photos never expose another nominee.
