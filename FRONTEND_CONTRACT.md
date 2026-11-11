# Contra frontend contract

Everything the frontend may rely on. The backend owns every rule, number and status word; the
frontend draws what it is given and sends back the actions it was offered. Exact TypeScript types are
in `src/view.ts` (`Screens`, `Action`, `Status`, `BackChargeDetail`). `contract/samples/` holds the real
JSON for every demo step, so you can build and style the screens without running the backend
(regenerate with `npm run contract:samples`).

## Two ways to connect

**A. Same Node process (Next.js server actions or route handlers).** Recommended if the frontend is
Next.js inside this repo.
```ts
import { App } from "./src/app.ts";
import { runAction } from "./src/commands.ts";
import { buildScreens, backChargeDetail, type Action } from "./src/view.ts";
import { loadPmEmails } from "./ingest/eml.ts";
// One App per server process, kept on globalThis; Node.js runtime only (node:sqlite).
const app = (globalThis as any).__contra ??= new App("data/demo.db");
// PM emails from fixtures/emails/*.eml (null when the folder is missing: built-in sample). Async: load once.
const pmEmails = (globalThis as any).__contraEmails ??= await loadPmEmails();
buildScreens(app);                    // read
// by: the signed-in person, from your own session check: { kind: "human", id: username, role: "pm" | "controller" | "ap" }.
await runAction(app, action, { choice, reason }, { pmEmails, by }); // change state (one function for every button); always a Promise
backChargeDetail(app, "BC-4470");     // detail screen
app.ctx.contra.creditMemo("VC-1");    // { filename, text }
// Live inbox (optional): a second App on its own database, never the demo's. See "Workspaces".
const live = (globalThis as any).__contraLive ??= new App("data/live.db", { workspace: "live" });
```

`runAction` returns a Promise for every action. Always `await` it, and catch refusals with
`try { await runAction(...) } catch (e) { ... }`: a refused action (not offered, a rule, a bad choice) is a
rejected Promise, never a synchronous throw, so a `try`/`catch` without `await` catches nothing and the
refusal becomes an unhandled rejection. Re-read `buildScreens(app)` after the await, not before.

In process there is no API in front of the core, so the host does what the API does (see
[Signing in](#signing-in)): check the session, keep accounts without `--live` out of the live workspace,
and pass `by`. The live workspace refuses a step without `by`.

**B. HTTP JSON API (any stack: Vite, plain React, another language).** Run `npm run api`.
It listens on `http://127.0.0.1:4100` (set `CONTRA_PORT` to change). CORS headers are sent only to the
origins in `CONTRA_ALLOWED_ORIGINS` (comma-separated, exact match, e.g.
`http://localhost:5173,https://demo.example.com`); unset, that is `http://localhost:3000` (`next dev`).
A request whose `Origin` header is any other origin is refused with 403 on every method, before anything
runs: add your frontend's origin before calling the API from a browser. Requests with no `Origin` header
(curl, server-to-server) are unaffected.

**Every POST must send `Content-Type: application/json`** (a `charset` parameter is allowed), including
`POST /api/reset` with an empty `{}` body. Anything else, or no Content-Type, is refused with 415 before the
body is read.

**Every route needs a session except `POST /api/login` and `GET /api/health`** (see
[Signing in](#signing-in)). Without one, every other route, including unknown ones and the SSE stream,
answers 401 `"sign in first"` before anything runs.

The first five routes take an optional `?workspace=demo|live` (default `demo`; see [Workspaces](#workspaces)).

| Method and path | Returns |
|---|---|
| `GET /api/screens` | `Screens` |
| `POST /api/action` with body `{ "action": <Action>, "input"?: { "choice"?: string, "reason"?: string } }` | `{ "ok": true, "screens": Screens }` |
| `POST /api/reset` | `{ "ok": true, "screens": Screens }` (that workspace starts over; the other is untouched) |
| `GET /api/backcharge/:ref` | `BackChargeDetail` |
| `GET /api/credit/:id/memo` | `{ "filename": string, "text": string }` |
| `GET /api/health` | No session needed. Signed out: `{ "ok": true }` and nothing else. Signed in: `{ "ok": true, "workspaces": <the ones this account may open>, "inbox": InboxStatus or null }`; `inbox` is `null` for an account without `--live` (see [Live inbox and memos](#live-inbox-and-memos)). No secrets. |
| `GET /api/events` | Server-Sent Events: `screens-changed` and `heartbeat` (see [Real-time updates](#real-time-updates)). |
| `POST /api/try` with body `{ "subject", "body", "from"?, "to"? }` | `TryResult` (see [Try any email](#try-any-email)). Never changes demo state. |
| `POST /api/login` with body `{ "username", "password" }` | No session needed. The same body as `GET /api/me`, plus the session cookie (see [Signing in](#signing-in)). |
| `GET /api/me` | `{ "ok": true, "user": { "username", "role": "pm" \| "controller" \| "ap", "live": boolean }, "expiresAt": ISO time, "workspaces": ["demo"] or ["demo", "live"] }` |
| `POST /api/logout` with body `{}` | `{ "ok": true }`; ends the session on the server and clears the cookie. |

Errors are `{ "ok": false, "error": "<message to show the user>" }`:
- **400:** the action isn't one the API knows, or its fields are wrong, or `workspace` isn't `demo` or `live`.
- **401:** no session (never signed in, signed out, expired, or an unknown cookie): `"sign in first"`. From
  `POST /api/login`: `"wrong username or password"` (the same words for an unknown username). See
  [Handling 401](#handling-401).
- **403:** the request's `Origin` isn't in `CONTRA_ALLOWED_ORIGINS` (checked first, on every method); or
  `?workspace=live` from an account created without `--live`; or `sendCreditMemo` from an account without
  `--live` (it emails the AP inbox for real). Nothing ran.
- **404:** unknown back-charge, credit or route, or `?workspace=live` on a server without a live inbox.
- **409:** a rule refused it. This includes any action the screens aren't currently offering (a stale
  screen, a double-click or a hand-made request), which comes back as "… is not available right now", and,
  in the live workspace, a step your role may not take or a credit you may not approve (see
  [Who may do what](#who-may-do-what)). Nothing changed; refresh the screens.
- **413:** the request body is too large (`POST /api/try`: over 256 KB; other routes: over 64 KB).
- **415:** a POST without `Content-Type: application/json`. Nothing ran.
- **429:** `POST /api/try`: another email is being checked, the hourly limit for your address is reached,
  or the daily demo cap is reached. `POST /api/login`: too many failed sign-ins from your address, or for
  this username from your address; from that address even the right password is refused for 15 minutes
  (other addresses are unaffected, so nobody can lock a known account). The message says which.
- **500:** an unexpected server error. The message is always "internal error".
- **503** (`POST /api/try` only): no API key is configured, the model call failed, or the route isn't
  enabled. A failed model call gets one fixed sentence per failure kind (key refused, rate-limited, timed
  out, unreachable, service error, unreadable answer); the model service's own message is never shown.

Show the message; don't retry.

## Signing in

There is no sign-up. Accounts are made on the server's machine with
`npm run user:add -- <username> <pm|controller|ap> [--live] [--email <address>]`, which asks for the password (stored as a
salted scrypt hash in `data/auth.db`). `--live` lets the account open the live workspace (real Gmail, real
memo emails); without it the account sees only the scripted demo.

**Flow.**
1. On start-up, call `GET /api/me`. 200: signed in; use `user` and `workspaces`. 401: show the sign-in page.
2. The sign-in page sends `POST /api/login` with `{ "username", "password" }` as JSON. 200 sets the
   session cookie and returns the `/api/me` body. 401 `"wrong username or password"`: show it, keep the
   username, clear the password. 429: show the message (it says how long to wait). After repeated wrong
   passwords for a username (from anywhere), the server answers that username's sign-ins more slowly, up
   to 8 seconds: keep the button disabled with "Signing in…" until the answer comes; don't time out early.
3. "Sign out" sends `POST /api/logout` with `{}`, then shows the sign-in page.

**The session cookie** is `contra_session`: `HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`, plus
`Secure` when the server runs with `CONTRA_SECURE_COOKIES=1` (set it whenever the API is served over
HTTPS). A session lasts 12 hours from sign-in and isn't extended by use; sign-out ends it on the server, so
an old copy of the cookie is useless. The session id is never in a response body, and the frontend must
never put it in a URL, `localStorage`, a log or client-side JavaScript.

**How the cookie travels.**
- **Next.js server (the repo's UI, `ui/api.ts`).** The browser talks only to Next; Next calls the API.
  The login server action posts to `/api/login`, reads the API's `Set-Cookie`, and sets the same value as
  its own HttpOnly, SameSite=Lax cookie (Secure in production) with the same Max-Age. Every later API call
  from the Next server sends `cookie: contra_session=<value>` (from `cookies()`), including
  `GET /api/events` when Next proxies it. Logout calls `/api/logout` with it, then deletes its own cookie.
- **A browser calling the API directly** (another stack): send `credentials: "include"` on every `fetch`
  and open the stream with `new EventSource(url, { withCredentials: true })`. The API answers allowed
  origins with `Access-Control-Allow-Credentials: true` (never with `*`). Because the cookie is
  SameSite=Lax, the page and the API must be on the same site: `localhost:3000` and `127.0.0.1:4100` are
  different sites, so use one host name for both.

### Handling 401

Any route can answer 401 `"sign in first"` once the session has expired or been ended, including the
SSE stream (its connection is refused; `EventSource` reports an error and keeps retrying, so close it).
On a 401 from anything but `/api/login`: close the stream, drop cached screens, show the sign-in page with
"Your session has ended; sign in again", and after sign-in return to the screen the person was on and
re-read it. Don't re-send the request that got the 401: nothing ran, and the screen it came from may be
stale. `GET /api/health` never answers 401; signed out it says only `{ "ok": true }`.

### Who may do what

Screens and buttons are the same for every account. The server decides who may take a step and says
why when it refuses (409); show the message. Don't hide or disable buttons by role yourself.

| | Demo workspace | Live workspace |
|---|---|---|
| Who can open it | Any signed-in account | Only accounts created with `--live` (else 403) |
| Who each step is recorded under | The scripted actor (Dana Ortiz PM, Lee Chen Controller, Sam AP), with `presented by <username>`: any account can present every step | The signed-in account and its role |
| `approveNotice` | Presented as Dana Ortiz (PM) | A PM |
| `approveCredit`, `rejectCredit` | Presented as Lee Chen (Controller) | A controller, and for `approveCredit` not one who raised or linked any of the credit's back-charges (separation of duties). "Raised" includes live mail sent from the address given as the account's `--email`: its items' audit shows `raised by <username> (<Role>): the email came from their address`. |
| `turnOnCredits` | Presented as Sam (AP) | AP |
| `sendCreditMemo` | `--live` accounts only (403 otherwise): it emails the AP inbox for real | `--live` accounts (all who can open it) |

Live refusals read, for example, `"approving credit VC-1 needs the Controller role; pat.pm is a PM"`,
`"approving notice N-1 needs the PM role; cy.ctl is a Controller"` or
`"separation of duties: cy.ctl linked BC-7501, so cy.ctl can't approve credit VC-1; another controller must"`.

Samples: `contract/samples/auth-login.json` (request and response, with `Set-Cookie`; the session id is
shown as `<session id>`), `auth-me-live-pm.json`, `auth-me-demo-only.json`, `auth-health-signed-out.json`,
`auth-health-demo-only.json`, `auth-logout.json` and `auth-errors.json` (401, 429 and 403 bodies).

## What `Screens` contains

| Field | Use it for |
|---|---|
| `workspace` | `"demo"` or `"live"`: which workspace these screens are. In `"live"`, label the screens **"Live inbox"** so they're never mistaken for the scripted demo. |
| `now` | The workspace's clock. Demo: simulated, starting at the demo's start time. Live: the real time plus an offset. "Advance a week" adds 7 days in either workspace and nothing else changes the live offset. |
| `extractionSource` | `"model"`, `"sample"`, `"mixed"` or `null`. When it is `"sample"`, the Inbox must say **"Sample extractions (hand-written), not model output"**. |
| `emailSource` | `"eml"`, `"builtin"`, `"gmail"`, `"mixed"` or `null` (before ingest). Where the Inbox's PM emails were read from. Show it in the Inbox beside the extraction note: **"Emails: .eml files"** for `"eml"`, **"Emails: built-in sample"** for `"builtin"`, **"Emails: Gmail inbox"** for `"gmail"`, **"Emails: more than one source"** for `"mixed"`. |
| `nextStep` | `{ text, action }` for the presenter bar. Highlight `action`'s button. In `demo`, `action` is `null` only at "Demo complete". In `live`, it is also `null` while waiting for mail ("Waiting for back-charge emails from the live inbox") while the PM must choose a subcontract in an Inbox row, and while the PM must confirm an amount read from an image in an Inbox row; show the text without a button. |
| `opener` | The missed back-charges screen. Always show **"Sample data"**. Totals are already formatted; rows carry `ref`, `status`, `amount` and `evidence`. |
| `inbox[]` | `kind`, `ref`, `emailSubject`, `emailFrom`, `vendorAsWritten`, `amount`, `sourceSentence` (show beside the amount), `sourceLocation` (where that sentence is: `"email body"`, `"attachment estimate.pdf, page 2"`, or `"attachment IMG_2041.jpg"` for a photo; show it with the sentence), `photoAmount` (`{ pmEntered, modelRead }`, both formatted like every amount, once a person confirmed an amount read from an image; else `null`; see [Amounts read from an image](#amounts-read-from-an-image)), `attachments[]` (what became of each of the email's attachments, in words; show them all, skipped ones included, as written), `linkExplanation[]`, `status`, `actions[]`. `kind` is `"backCharge"` (an extracted back-charge, with a detail screen) or `"rejected"` (see [Items not taken in](#items-not-taken-in)). For a `"backCharge"` row, `amount` and `sourceSentence` are `""` only while its amount is an unconfirmed reading of an image. |
| `outbox[]` | Notices: `id`, `total`, `refs`, `body` (shown as written, preformatted), `status`, `actions[]`. |
| `credits[]` | `id`, `amount`, `job`, `refs`, `amountNotes[]` (one line per item whose amount a person confirmed from an image, with both readings, e.g. `"BC-7403: amount confirmed by dana.ortiz (PM) from attachment IMG_2041.jpg (PM entered $640.00; model read $604.00)"`; show them beside the amount, above the Approve button, as written; usually empty), `status`, `actions[]`, `hasMemo` (when true, offer "View memo"), `memo`: the memo's delivery to the AP inbox as a `Status` (e.g. "Memo not sent", "Memo sent to …", "Memo not sent: … You can send it again."), or `null` when there is no memo yet. Show `memo.label` as written. |
| `bills[]` | Always show **"Simulated Ramp"**. `vendor`, `job`, `amount`, `creditsOn`, `status`, `paid`, plus `check`: `status`, `actions[]` (sentences), `warnings[]`, `wouldPay`. Also has `actions[]` (buttons). |
| `pmQueue[]` | `ref` and `status` for items a person must look at, including items not taken in (their `ref` can be `""`). |
| `audit[]` | Newest first: `seq`, `at`, `actor` (already worded: `"lee.chen (Controller)"`, or in the demo `"lee.chen (Controller), presented by <username>"`), `what`, `evidence[]`. |

`Status` is `{ label, tone }`. **The label carries the meaning; show it as text.** `tone` (`ok`, `warn`,
`danger`, `info` or `idle`) is decoration only, never the only signal.

All amounts arrive as formatted strings (`"$11,500.00"`). Never parse, add or reformat them.

## Buttons: `Action`

Render each `actions[]` entry as a button, and when clicked send exactly that object back.

| `command` | Fields | Button label |
|---|---|---|
| `ingestPmEmails` | none | Ingest PM emails |
| `confirmLink` | `ref` | Confirm link |
| `chooseSubcontract` | `ref`, `options[]` | A picker plus Confirm. Send `input.choice` as one of `options`. |
| `confirmImageAmount` | `ref`, `options[]` | Only on an item held just because its amount was read from a photo or scanned page. An amount field ("Type the amount you see in the image"), a picker of `options` (often one) and Confirm. Send `input.amount` (what the person typed, e.g. `"$640.00"` or `"640.00"`) and `input.choice`. The typed amount may differ from the model's reading (a misread photo): it becomes the item's amount, both are recorded, and the credit shows both in `amountNotes`. It is refused (409, the item stays held) when it isn't more than $0.00, or when the email's text (body or a PDF page) gives the back-charge a different amount; the message says which. Don't prefill the amount field: the server sends nothing to prefill it with (see [Amounts read from an image](#amounts-read-from-an-image)). Contra doesn't keep the image: the person checks it in the original email (`sourceLocation` names the file). |
| `draftNotice` | `subcontractId` | Draft notice |
| `approveNotice` | `noticeId` | Approve notice (a PM's step; see [Who may do what](#who-may-do-what)) |
| `sendNotice` | `noticeId` | Send notice |
| `ingestSubReply` | `noticeId` | Ingest sub's reply |
| `advanceDays` | `days` | Advance a week (days = 7) |
| `evaluateAll` | none | Check eligibility |
| `proposeCredit` | `subcontractId` | Propose credit |
| `approveCredit` | `creditId` | Approve credit (a controller who didn't raise or link its items) |
| `rejectCredit` | `creditId` | A reason field plus Reject. Send `input.reason`; it must not be empty. |
| `billArrives` | none | Bill arrives |
| `turnOnCredits` | `billId` | Turn on credits (AP) |
| `payBill` | `billId` | Pay (simulated) |
| `sendCreditMemo` | `creditId` | Send credit memo. Appears only when the server has a memo sender (live mode, `CONTRA_INBOX=gmail`), for a credit with a recorded approval whose memo isn't sent, or whose last send failed (the retry). It emails the AP inbox for real, so an account without `--live` gets 403. The response comes back after the send is recorded (a few seconds); disable the button meanwhile. In process, `await runAction(...)` settles only then. |

**Test ids** (the browser test selects on these): `data-testid="{command}-{id}"`, where id is the
action's `ref`, `noticeId`, `creditId`, `billId` or `subcontractId`. Use just `{command}` when the
action has none. The presenter bar's copy of a button uses `presenter-{command}[-{id}]`.

A button only appears when its action is legal right now. Don't add buttons the backend didn't send:
`runAction` refuses any action that isn't currently on screen.

## Real-time updates

`GET /api/events` is a Server-Sent Events stream (use `EventSource`; the same Origin allow-list applies).
It needs a session like every other route (cross-origin: `withCredentials: true`). The live workspace's
events reach only streams opened by `--live` accounts.
- `event: screens-changed`, `data: {"reason": "action" | "reset" | "inbox", "workspace": "demo" | "live"}`:
  after every successful action, every reset, and every inbox poll that ingested something (always
  `"live"`). One stream carries both workspaces: re-read `GET /api/screens?workspace=<workspace>` only
  when it is the workspace on screen. The event never carries screen data itself.
- `event: heartbeat`, `data: {}`: every 15 seconds, so the connection stays open. Ignore it.

## Workspaces

There are two separate sets of state, each its own App and database:

| | `demo` (default) | `live` |
|---|---|---|
| Exists | Always | Only with `CONTRA_INBOX=gmail` (`/api/health` lists it in `workspaces`) |
| Database | `data/demo.db` | `data/live.db` |
| Seed | Jobs, subcontracts, aliases, Ramp vendors, the opener's history | The same |
| Emails | The scripted demo's own (built-in or `fixtures/emails/*.eml`), its scripted sub reply and the $48,000 bill | Only mail from the live inbox. The scripted emails, reply and bill are refused there. |
| `nextStep` | The demo script (SPEC section 3) | The same workflow for whatever arrived: confirm, notice, window, credit, memo |
| Clock (`now`) | Simulated, from the demo's start time; saved in `data/demo.db` | Real time plus an offset that starts at 0; only "advance a week" adds to it; the offset is saved in `data/live.db` and survives restarts |
| Email times | From the seed | When Gmail received the message (its `internalDate`), shown in the email's audit evidence as `received <ISO time>` |

Live mail is written only to `live`; the core refuses it in `demo`. So the scripted demo's notice
($15,500.00), credit ($11,500.00) and payment ($36,500.00) can't be changed through the inbox, even by an
email about the demo's own subcontract.

Who can open which: any signed-in account opens the demo; only an account created with `--live` opens
`live` (any other gets 403 on every `?workspace=live` route, whether or not the server has a live
workspace). `GET /api/me` lists the workspaces the account may open; show the workspace switch only when
it lists both.

Addressing a workspace:
- **HTTP:** add `?workspace=live` to `GET /api/screens`, `POST /api/action`, `POST /api/reset`,
  `GET /api/backcharge/:ref` and `GET /api/credit/:id/memo`. No parameter (or `workspace=demo`) is the demo.
  An action is checked against the screens of the workspace it is sent to, so a button from one workspace
  sent to the other is refused with 409.
- **SSE:** one stream, `GET /api/events`; each `screens-changed` names its `workspace`.
- **Reset:** `POST /api/reset` resets the demo only; `POST /api/reset?workspace=live` resets live only.
  Resetting live forgets what was ingested, so the next poll reads the intake's newest mail again (up to 20
  messages, each one model call, counted against the daily cap).
- **In process:** use the App you opened (`new App("data/live.db", { workspace: "live" })` for live). A
  database opens only as the workspace it was made for.
- `POST /api/try` always reads the demo's seed and changes neither workspace.
- Samples: `contract/samples/live-00-waiting-for-mail.screens.json`, `live-01-after-an-email-arrives.screens.json`
  (a made-up email with a hand-written extraction) and `live-02-after-an-email-with-attachments-arrives.screens.json`
  (a made-up email with a PDF read as text, a photo and a skipped HEIC; BC-7153 shows `confirmImageAmount`, with
  its amount withheld), with `live-detail-BC-7153.json`, and `live-04-after-a-photo-amount-is-confirmed.screens.json`
  (the PM typed $640.00 for BC-7153, which the model had read as $604.00: `photoAmount` has both).

## Live inbox and memos

With `CONTRA_INBOX=gmail`, the server polls the demo Gmail inbox and ingests only mail delivered to the PM
intake address (`<local>+backcharges@<domain>`), into the `live` workspace (`emailSource` `"gmail"`).
Credit memos are sent to a stand-in AP inbox (`<local>+ramp-ap@<domain>`), not to Ramp, from either
workspace's credit rows (and from `live`'s `nextStep`), by `--live` accounts only.

`GET /api/health` → `inbox` (signed in with a `--live` account; `null` for any other account, and absent
when signed out):

| Field | Meaning |
|---|---|
| `mode` | `"gmail"` (live inbox) or `"sample"` (demo emails only) |
| `address` | The PM intake address being read, or `null` |
| `lastPollAt` | ISO time of the last poll, or `null` |
| `lastError` | The last problem, in words, or `null` |
| `status` | `"off"`, `"starting"`, `"ok"`, `"error"`, `"expired: run npm run gmail:auth"`, `"not configured: …"` or `"paused: the daily cap of N model calls is reached; …"`. Show it as written. Expired is normal (Google expires the demo's sign-in after 7 days); the screens keep working. |
| `modelCalls` | `{ today, cap, capReached, resetsAt }`: live extraction's model calls this UTC day against `CONTRA_LIVE_DAILY_CAP` (default 50; failed calls and retries count), and when the count resets (ISO, midnight UTC). `null` without a live inbox. When the cap is reached, new mail waits in Gmail and is extracted after the reset; it is never dropped. |

Only mail from a sender on `CONTRA_INTAKE_ALLOWED_SENDERS` (comma-separated addresses or `@domain` entries;
empty means nothing is ingested) whose domain passed Gmail's own DKIM or SPF check is extracted.
`npm run inbox:check` lists each message's skip reason ("no allowed senders configured", "sender not
allowed (…)", "sender not authenticated", …), so a wrong allow-list shows on every message.

## Attachments

Attachments of PM emails (live Gmail and `.eml` files) are read when the email is ingested:

- **A PDF with a text layer on every page** is read as text, page by page, on the server. The model gets
  that text, and every sentence it cites from it is checked word for word against that page, like the body.
  The Inbox shows `sourceLocation` `"attachment <name>, page <n>"`.
- **A photo (JPEG, PNG, GIF, WebP) or a PDF with any page that has no text layer (a scan)** is shown to the
  model as an image. Nothing read from an image can be checked word for word, so an item whose amount comes
  from one is always held (`amount only in image`, below) until a person types the amount they see and
  confirms it (`confirmImageAmount`). It never proceeds on its own.
- **Limits:** at most 5 PDFs and photos per email, each at most 10 MB; a PDF at most 20 pages; a photo at most
  about 7.1 MB and 8000×8000 px (the Claude API's limits). A whole message over 25 MB isn't read at all
  (`npm run inbox:check` shows it as "larger than 25 MB"). Anything else is listed as skipped, with the reason,
  in the row's `attachments[]` and in the email's audit entry: over a limit, HEIC or another image type the
  model can't read, password-protected or damaged PDFs, files that aren't PDFs or photos, and small images
  embedded in the email's HTML (logos and signatures).
- Text in an attachment counts as the email's own text for the hold rules: text aimed at an AI (in a PDF's
  text or a file name), a back-charge number no item accounts for, a dispute, and an amount for the same
  back-charge that differs between the body and an attachment (`conflicting amounts`).

### Amounts read from an image

Until a person confirms an amount the model read from a photo or scanned page, **nothing the API returns
carries the model's reading** (screens, detail, audit, PM queue, SSE), so the person reads the image without
being anchored on the model's figure:

- The Inbox row and the detail screen have `amount: ""`, `sourceSentence: ""` (the sentence is the model's
  reading too) and `photoAmount: null`. `sourceLocation` still names the file. The detail's `description`
  shows any dollar amount in it as `[amount withheld]`; so does a `disputeSentence` read from an image.
- The stored audit log keeps the reading like any other evidence; only `audit[]` and `history[]` leave it out.
  There the item's `extracted` entry says `extracted (amount read from an image: withheld until a person
  confirms the amount from the image)`, with where it is (`in attachment IMG_2041.jpg`) and no sentence. A
  `conflicting amounts` hold says what the email's text gives, `not the amount read from the image`. A later
  email's image reading of another amount for an existing item shows as `<email id>: another amount, read by
  the model from an image in that email (...)`. After the confirmation the item's entries show as stored, with
  the reading.
- After `confirmImageAmount`, `amount` is what the person typed, `sourceSentence` is the model's sentence, and
  `photoAmount` is `{ "pmEntered": "$640.00", "modelRead": "$604.00" }` (both always present; they may be
  equal). Show both from `photoAmount`; never parse `audit[]` or `amountNotes[]` for them. The confirmation's
  audit entry and the credit's `amountNotes[]` carry both readings too.

## Hold reasons

`status.label` for a held item is `Held: ` and then its reasons, joined by `; `. Each reason is one of these
(`HOLD_WORDS` in `src/view.ts`). Show them as written; never reword them.

| Reason | Words |
|---|---|
| `dispute_noted_in_source` | dispute noted in the PM's email |
| `disputed_by_sub` | disputed by the sub |
| `no_clause` | no back-charge clause |
| `clause_forbids_deduction` | clause does not allow deduction |
| `no_notice_evidence` | no notice was sent |
| `no_payments_vendor` | sub not mapped to a Ramp vendor |
| `unverified_evidence` | amount not found in the source email |
| `conflicting_amounts` | different amounts for the same back-charge (in two emails, or in an email and its attachment) |
| `unresolved_link` | not linked to a subcontract |
| `only_in_quoted_text` | found only in quoted or forwarded text (may already have been sent or credited) |
| `suspicious_instructions` | email contains instructions aimed at an AI or automated system |
| `unaccounted_reference` | the email mentions a back-charge number that wasn't extracted |
| `amount_only_in_image` | amount read from a photo or scanned page, which can't be checked word for word; a person must confirm it |

Only `amount_only_in_image`, when it is an item's only reason, has a button (`confirmImageAmount`).

## Items not taken in

Nothing a PM sends vanishes. When the model returns something for an email that validation refuses (a
page or attachment that doesn't exist, an amount that can't be read exactly, a missing BC number, an answer
in the wrong form, ...), it is never a back-charge, but it is an Inbox row with `kind: "rejected"`:

- `status.label` is `Held: not taken in: <the reason in plain words>; a person must read the email`, for example
  `Held: not taken in: the model said the amount is on page 3 of estimate.pdf, which has only 2 pages; a person
  must read the email`. Show it as written.
- `emailSubject`, `emailFrom` and `attachments[]` say which email it came from.
- `ref` is its BC number when the model gave a readable one, else `""`. `vendorAsWritten`, `amount`,
  `sourceSentence` and `sourceLocation` are `""`: the model's unchecked text is never shown as if it were checked.
- No `actions` and no detail screen: don't link it to `backChargeDetail` (its `ref` may be another row's,
  or empty). A person reads the original email. It is also in `pmQueue[]` and in the audit log.

## Detail screen: `BackChargeDetail`

| Field | Contents |
|---|---|
| Identity | `ref`, `description`, `amount`, `photoAmount` (as in the Inbox row), `status`. `amount` is `""` while it is an unconfirmed reading of an image ([Amounts read from an image](#amounts-read-from-an-image)). |
| Source | `vendorAsWritten`, `jobRef`, `email` (`{ id, subject, from, body, attachments, attachmentText }`), `sourceSentence`, `sourceLocation`, `disputeSentence`. Highlight `sourceSentence` inside `email.body` when `sourceLocation` is `"email body"`, else inside the `attachmentText` entry whose `where` equals `sourceLocation` (`attachmentText` is `{ where, text }[]`, one per page of each PDF read as text; a photo has none). `email.attachments` is the same list of words as the Inbox row's. A sentence can cross a line break in `body` (an .eml's HTML part is re-wrapped), so match it with runs of whitespace treated as equal. |
| `link` | `subcontractId` and `explanation[]`, e.g. alias, then party, then job |
| `clause` | `section`, `text` (quote it), `responseWindow` (e.g. "5 working days"), `deductionAllowed`, `noticeRequired`. Can be `null`. |
| `eligibility` | `status`, `holdReasons[]` (already in words), `waitingFor[]`, `trace[]` (lines beginning PASS, HOLD or WAIT). For an amount a person confirmed from an image, the evidence line is `PASS amount confirmed by <who> from <attachment>`, never "verbatim". |
| `history[]` | This item's audit events |

## Try any email

A person types or pastes a back-charge email; Contra runs the real extraction (one live model call) and
the real ingest checks, and shows what it would do. **Nothing is saved**: the demo screens, the audit log
and the ERP data are unchanged, so this can be used at any point in the demo. In process, call
`tryEmail(app, input, settingsFromEnv(process.env))` from `server/try.ts`; over HTTP, `POST /api/try`.
The server never logs or stores the email's text, subject or addresses, including when the call fails; it
is sent only to the model. Don't log it in the frontend either.

**Request** (JSON). Unknown fields are refused with 400.

| Field | Rules |
|---|---|
| `subject` | string, at most 300 characters (may be empty) |
| `body` | string, not blank, at most 20,000 characters |
| `from`, `to` | optional strings, at most 300 characters each. The extractor may read the sub's name from `to`. |

**Limits**, because each call spends the demo's API key (all in memory; a server restart resets them):
- one request in flight at a time, for everyone;
- 30 model calls per rolling hour per client IP address;
- a daily demo cap for everyone together, `CONTRA_TRY_DAILY_CAP` (default 200), that resets at midnight UTC.

Over any limit: 429, and the message says which (the daily cap's message says it is the daily demo cap).
A 400 (bad input) or a 503 for a missing key uses no slot; a model call that fails does. Show the message
and let the person try again later; don't retry automatically.

**Response** (`TryResult`, plus `"ok": true` over HTTP):

```ts
{
  model: string;            // the model that answered
  latencyMs: number;        // the model call only
  note: string;             // what each outcome means and what a credit still needs; show it (see UI rules)
  items: {
    ref: string;            // "BC-6612"
    amount: string;         // formatted, "$1,275.00"; never parse it
    description: string;
    vendorAsWritten: string;
    jobRef: string;
    sourceSentence: string; // the sentence the amount came from, as the model copied it
    highlight: [start, end] | null; // offsets of sourceSentence in the body you sent; null when it isn't there
    checks: { name: string; passed: boolean; detail: string }[]; // in order, already in words
    holdReasons: string[];  // already in words; empty when not held
    link: { subcontractId: string | null; explanation: string[] };
    outcome: "held_at_intake" | "will_hold_dispute" | "needs_link" | "ready_for_notice"; // never "credited"
  }[];
  rejected: { reason: string }[]; // model output the validator refused, in words
}
```

`outcome` is computed in code from `holdReasons` and `checks`, first match wins:

| `outcome` | When | Show as |
|---|---|---|
| `held_at_intake` | `holdReasons` is not empty | **Held when the email came in**, then the hold reasons |
| `will_hold_dispute` | not held, but the "No dispute noted in the email" check failed | **Will be held: dispute noted in the email** |
| `needs_link` | not held, no dispute, but the "Linked to one subcontract" check failed | **PM must choose the subcontract** |
| `ready_for_notice` | none of the above | **Ready for a notice to the sub** |

No outcome means a credit: a credit still needs a notice to the sub, the response window to pass, the
eligibility check and a controller's approval. `contract/samples/try-<outcome>.json` holds one
`{ request, response }` per outcome (made-up emails with hand-written model output, so `model` says so).

`checks` are, in order: the amount and its sentence are in the email word for word; (when the model noted
a dispute) the dispute sentence is in the email; stated in the email's own text, not only in quoted or
forwarded mail; no text aimed at an AI or automated system; every back-charge number in the email was
extracted; no dispute noted in the email; linked to one subcontract. When an item is held, linking is not
attempted and `link.explanation` says so. When it isn't held but can't be linked, `link.explanation` gives
the reasons and `subcontractId` is null.

**UI rules**
- **Show the highlight.** Display the body as sent and mark `body.slice(start, end)`. The offsets index
  the exact `body` string in the request (JavaScript string indices), so keep the text you sent rather than
  re-reading it from the text box. When `highlight` is null, say "Source sentence not found in the email"
  next to `sourceSentence`; never highlight a guess.
- **Show the checks as words.** One line per check: the word **Passed** or **Failed**, then `name`, then
  `detail`. Color may decorate but never carries the result alone. Show `holdReasons` as written.
- **Show the outcome in words, with the note.** Use the "Show as" wording above for each item's `outcome`,
  and show `note` next to it every time. Never word any outcome as a credit or a deduction.
- Show `rejected[].reason` as written, and an empty result ("No back-charge found") when both lists are
  empty.
- Say it is a live model call and that nothing is saved.

## Demo checkpoints (must match SPEC.md section 3)

Follow `nextStep` from a fresh reset. The screens must show:
1. Four back-charges: BC-4467 $6,800.00, BC-4468 $4,700.00, BC-4470 $2,750.00 and BC-4471 $4,000.00.
2. A $15,500.00 notice, with BC-4470 held for the dispute noted in the PM's email.
3. BC-4471 held as disputed by the sub.
4. A $11,500.00 credit, then a $48,000.00 bill that pays $36,500.00.

`contract/samples/` contains each of these states.

## Stability

Field and command names above won't change without telling the frontend owner. New fields may be
added. Anything not listed here is internal and may change.
