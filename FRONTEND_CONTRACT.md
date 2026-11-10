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
runAction(app, action, { choice, reason }, { pmEmails }); // change state (one function for every button)
backChargeDetail(app, "BC-4470");     // detail screen
app.ctx.contra.creditMemo("VC-1");    // { filename, text }
```

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

| Method and path | Returns |
|---|---|
| `GET /api/screens` | `Screens` |
| `POST /api/action` with body `{ "action": <Action>, "input"?: { "choice"?: string, "reason"?: string } }` | `{ "ok": true, "screens": Screens }` |
| `POST /api/reset` | `{ "ok": true, "screens": Screens }` (fresh demo) |
| `GET /api/backcharge/:ref` | `BackChargeDetail` |
| `GET /api/credit/:id/memo` | `{ "filename": string, "text": string }` |
| `GET /api/health` | `{ "ok": true }` |
| `POST /api/try` with body `{ "subject", "body", "from"?, "to"? }` | `TryResult` (see [Try any email](#try-any-email)). Never changes demo state. |

Errors are `{ "ok": false, "error": "<message to show the user>" }`:
- **400:** the action isn't one the API knows, or its fields are wrong.
- **403:** the request's `Origin` isn't in `CONTRA_ALLOWED_ORIGINS`. Checked first, on every method;
  nothing ran.
- **404:** unknown back-charge, credit or route.
- **409:** a rule refused it. This includes any action the screens aren't currently offering (a stale
  screen, a double-click or a hand-made request), which comes back as "… is not available right now".
  Nothing changed; refresh the screens.
- **413:** the request body is too large (`POST /api/try`: over 256 KB; other routes: over 64 KB).
- **415:** a POST without `Content-Type: application/json`. Nothing ran.
- **429** (`POST /api/try` only): another email is being checked, the hourly limit for your address is
  reached, or the daily demo cap is reached. The message says which.
- **500:** an unexpected server error. The message is always "internal error".
- **503** (`POST /api/try` only): no API key is configured, the model call failed, or the route isn't
  enabled. A failed model call gets one fixed sentence per failure kind (key refused, rate-limited, timed
  out, unreachable, service error, unreadable answer); the model service's own message is never shown.

Show the message; don't retry.

## What `Screens` contains

| Field | Use it for |
|---|---|
| `now` | The demo clock (it moves when "advance a week" runs). |
| `extractionSource` | `"model"`, `"sample"`, `"mixed"` or `null`. When it is `"sample"`, the Inbox must say **"Sample extractions (hand-written), not model output"**. |
| `emailSource` | `"eml"`, `"builtin"`, `"mixed"` or `null` (before ingest). Where the Inbox's PM emails were read from. Show it in the Inbox beside the extraction note: **"Emails: .eml files"** for `"eml"`, **"Emails: built-in sample"** for `"builtin"`, **"Emails: .eml files and built-in sample"** for `"mixed"`. |
| `nextStep` | `{ text, action }` for the presenter bar. Highlight `action`'s button. `action` is `null` only at "Demo complete". |
| `opener` | The missed back-charges screen. Always show **"Sample data"**. Totals are already formatted; rows carry `ref`, `status`, `amount` and `evidence`. |
| `inbox[]` | `ref`, `emailSubject`, `vendorAsWritten`, `amount`, `sourceSentence` (show beside the amount), `linkExplanation[]`, `status`, `actions[]`. |
| `outbox[]` | Notices: `id`, `total`, `refs`, `body` (shown as written, preformatted), `status`, `actions[]`. |
| `credits[]` | `id`, `amount`, `job`, `refs`, `status`, `actions[]`, `hasMemo` (when true, offer "View memo"). |
| `bills[]` | Always show **"Simulated Ramp"**. `vendor`, `job`, `amount`, `creditsOn`, `status`, `paid`, plus `check`: `status`, `actions[]` (sentences), `warnings[]`, `wouldPay`. Also has `actions[]` (buttons). |
| `pmQueue[]` | `ref` and `status` for items a person must look at. |
| `audit[]` | Newest first: `seq`, `at`, `actor` (already worded), `what`, `evidence[]`. |

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
| `draftNotice` | `subcontractId` | Draft notice |
| `approveNotice` | `noticeId` | Approve notice |
| `sendNotice` | `noticeId` | Send notice |
| `ingestSubReply` | `noticeId` | Ingest sub's reply |
| `advanceDays` | `days` | Advance a week (days = 7) |
| `evaluateAll` | none | Check eligibility |
| `proposeCredit` | `subcontractId` | Propose credit |
| `approveCredit` | `creditId` | Approve credit |
| `rejectCredit` | `creditId` | A reason field plus Reject. Send `input.reason`; it must not be empty. |
| `billArrives` | none | Bill arrives |
| `turnOnCredits` | `billId` | Turn on credits |
| `payBill` | `billId` | Pay (simulated) |

**Test ids** (the browser test selects on these): `data-testid="{command}-{id}"`, where id is the
action's `ref`, `noticeId`, `creditId`, `billId` or `subcontractId`. Use just `{command}` when the
action has none. The presenter bar's copy of a button uses `presenter-{command}[-{id}]`.

A button only appears when its action is legal right now. Don't add buttons the backend didn't send:
`runAction` refuses any action that isn't currently on screen.

## Detail screen: `BackChargeDetail`

| Field | Contents |
|---|---|
| Identity | `ref`, `description`, `amount`, `status` |
| Source | `vendorAsWritten`, `jobRef`, `email` (`{ id, subject, from, body }`), `sourceSentence` (highlight it inside `email.body`), `disputeSentence`. A sentence can cross a line break in `body` (an .eml's HTML part is re-wrapped), so match it with runs of whitespace treated as equal. |
| `link` | `subcontractId` and `explanation[]`, e.g. alias, then party, then job |
| `clause` | `section`, `text` (quote it), `responseWindow` (e.g. "5 working days"), `deductionAllowed`, `noticeRequired`. Can be `null`. |
| `eligibility` | `status`, `holdReasons[]` (already in words), `waitingFor[]`, `trace[]` (lines beginning PASS, HOLD or WAIT) |
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
