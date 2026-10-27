# ShinePro v2 — Architecture

## Layers

```
public/            Browser UI: vanilla ES modules, no build step, strict CSP
  assets/ui.js     html`` tagged template that escapes by default, API client, modal, toast
  app/             Staff workspace (hash router + one module per view)
src/
  domain/          Pure rules, no I/O: pricing, job state machine, payments, ledger, cash, scoring, permissions
  services/        Use cases: validate input, check permission and branch scope, write, audit
  db/              SQLite adapter (the only engine-specific code), migrations, idempotent seed
  http/            Node http server, route table, security headers, static files
  cli/             migrate, seed, legacy import, syntax check
test/              Unit tests (domain) and integration tests (real HTTP stack, in-memory DB)
```

A request passes through these steps:

1. Route matching.
2. A CSRF check (Origin header, JSON only) and a body size limit.
3. Session lookup, which builds the actor: roles, permissions, branch scope and worker id.
4. The service call, inside **one database transaction**.
5. A JSON response.

Any error rolls back every write that request made.

## Core concepts kept from v1

- **Price and commission snapshots.** A job references the exact price row and commission rule set that were in force when it was created. Changing a price or rule adds a new version and never edits an old one.
- **Quality gate before money.** Payment is only possible from `ready_for_payment`. Commission is earned only once quality is approved and payment is taken.
- **Explicit workflow.** `domain/jobs.js` lists every allowed transition, its permission and its guards. Anything not listed is refused.
- **Integer money, basis-point rates, half-up rounding.**
- **Idempotent payments and a balanced double-entry ledger.**
- **Role- and branch-scoped access, with an immutable audit trail.**

## What changed from v1, and why

| v1 problem | v2 |
| --- | --- |
| The browser prototype held all state in `localStorage`; roles were a dropdown | Every rule is enforced by the API; the UI just shows the result |
| Payments were accepted for jobs in *any* state, including cancelled | Payment only from `ready_for_payment`, and never while a discount is pending |
| Tips were not posted to the ledger | Tips post as `tips_payable`, are split among the workers and are paid out |
| Commission was not posted; refunds did not reverse it | Commission is posted as expense and liability; a full refund reverses it |
| Wax and Polishing had no Van price, so the price became 0 and the total could go negative | A service with no price for that vehicle type is refused; DB checks keep `final = original − discount ≥ 0` |
| The seed created a new business on every run, which broke public signup | The seed is idempotent |
| Signup sent the user to the portal without a session | Signup creates the session |
| The JSON body parser broke multi-byte Persian text split across network chunks | The body is read as bytes, then decoded once |
| `innerHTML` with unescaped user data across the UI (XSS) | Everything goes through `html```, which escapes by default; CSP is `script-src 'self'` with no inline code |
| Fixed commissions ignored the pool limit; roles could be typed freely | Roles come from the service's rule set; percentage and fixed amounts both count toward the pool |
| A request without an Idempotency-Key, or reusing one with a different body, was not detected | The key is required and the request body is hashed and compared |
| Cash "expected" figures were hard-coded | Expected cash = opening float + signed movements; closing differences post to the ledger and go to review |
| Loyalty balance was stored and could drift | The balance is derived from append-only transactions |
| A self-requested refund or discount could be self-approved | Four-eyes rule: the requester can never decide their own request |
| The worker score always gave 100 for attendance | Missing data is reported as missing and left out of the weighting |
| Reports used UTC days | Report days follow the branch time zone (Asia/Tehran by default) |

## Database

SQLite in WAL mode with foreign keys on. Every tenant table carries `business_id`, and branch-owned tables also carry `branch_id`. Triggers make these tables append-only: `audit_events`, `ledger_*`, `cash_movements`, `stock_movements`, `payment_parts` and `loyalty_transactions`.

Unique partial indexes enforce these rules:

- at most one open register per branch;
- at most one confirmed payment per job;
- at most one pending approval per subject.

## Moving to PostgreSQL later

`src/db/database.js` exposes `get`, `all`, `run`, `tx` and `migrate`. A PostgreSQL version must:

1. Keep `tx()` atomic per request. Use one pooled client per transaction and `SELECT … FOR UPDATE` on jobs and cash sessions.
2. Translate the migrations: `TEXT` timestamps become `timestamptz`, `INTEGER` money becomes `bigint`, and the triggers move to PL/pgSQL.
3. Make services `async`, because node:sqlite is synchronous by design.
