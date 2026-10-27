# ShinePro Car-Wash Operations — v2

A rebuild of `shinepro-car-wash-ops` that puts the business rules behind a real
server. Jobs, quality checks, payments, commissions, cash, expenses, inventory,
approvals and reports. It also includes a public website and a customer portal.

- **No npm dependencies.** It runs on Node.js only and uses Node's built-in SQLite.
- **Money is always whole toman.** Rates are basis points (10000 = 100%), rounded half-up.
- **The server enforces every rule.** Hiding a button in the UI is only a convenience.
- **Bookkeeping is double-entry.** The ledger and audit log are append-only at the database level.

## Requirements

- Windows 10/11, macOS or Linux
- Node.js **22.13 or newer** (24 LTS recommended), from <https://nodejs.org>

Check the installed version in PowerShell:

```powershell
node --version
```

## Quick local demo (Windows PowerShell)

```powershell
git clone https://github.com/rocke3tare-hub/shinepro-car-wash-ops-v2.git
Set-Location shinepro-car-wash-ops-v2
Copy-Item .env.example .env
npm run db:seed -- --demo
npm start
```

Open <http://localhost:8787/>. Every demo account (table below) uses the
password set in `.env` (`SEED_DEMO_PASSWORD`). Change it before sharing the machine.

## First run (Windows PowerShell)

```powershell
Set-Location "$HOME\Documents\rebuild\shinepro"
Copy-Item .env.example .env
notepad .env            # set PASSWORD_PEPPER to a long random value
npm test                # 38 automated tests
npm run db:seed -- --demo
npm start
```

Open <http://localhost:8787/> in your browser.

`db:seed` prints the owner password **once**. With `--demo` it also creates
these demo accounts, which all share the printed demo password:

| Email | Role |
| --- | --- |
| manager@shinepro.local | Branch manager |
| cashier@shinepro.local | Cashier |
| quality@shinepro.local | Quality controller |
| accountant@shinepro.local | Accountant |
| reza@shinepro.local | Worker |
| kian@shinepro.local | Team leader |

To choose the passwords yourself, set them in `.env` before seeding
(`SEED_OWNER_PASSWORD`, `SEED_DEMO_PASSWORD`). Seeding is safe to repeat: it
never duplicates data and never changes existing passwords.

## Pages

| URL | Who |
| --- | --- |
| `/` | Public site: services and prices, offers, sign up, sign in |
| `/app` | Staff workspace (each role sees only its own tools) |
| `/portal` | Customer portal: vehicles, visits, receipts, loyalty points, reports |
| `/register-business` | Request to onboard another car wash |

## How a job flows

1. **Create.** A cashier or manager creates the job. The price and commission rates in force at that moment are snapshotted, and later price changes never alter it. A discount above the threshold (default 10%) goes to someone else for approval.
2. **Work.** A worker starts the job and marks the tasks complete. Workers see only the jobs they are assigned to.
3. **Quality check.** A quality controller ticks the checklist. Anyone who worked on the job cannot approve it.
4. **Payment.** The cashier takes payment. It can be split across cash, card, bank transfer and customer credit, and the parts must equal the amount due. Tips are recorded separately and split among the workers.
5. **Completion.** The same database transaction completes the job, earns the commissions, posts balanced ledger entries, adds any cash to the open register and awards loyalty points. Retrying the request with the same `Idempotency-Key` never charges twice.
6. **Refunds.** A refund needs a second person's approval. A full refund reverses the job's commissions. If the commission was already paid out, it is recovered from the worker's next payout.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Start the server; migrations run automatically |
| `npm test` | Unit, API, security and import tests |
| `npm run check` | Syntax-check every JavaScript file |
| `npm run db:migrate` | Apply database migrations |
| `npm run db:seed [-- --demo]` | Create the business, branch, service catalog and owner (plus demo data) |
| `npm run import:legacy -- file.json [--apply]` | Import data from the old browser prototype |

## Moving data from the old prototype

1. Open the old `index.html` in your browser.
2. Press F12 to open the console and run `copy(localStorage.getItem("shinepro-ops-v1"))`.
3. Paste the result into a file, for example `old.json`.
4. Preview the import:

   ```powershell
   npm run import:legacy -- old.json
   ```

5. If the preview looks right, write it:

   ```powershell
   npm run import:legacy -- old.json --apply
   ```

The import brings over customers, vehicles, workers and inventory (as opening
stock). It does **not** bring over jobs, payments or expenses, because the
prototype never kept a ledger for them.

## Backups

All data lives in `data\shinepro.sqlite`. To back it up, stop the server and
copy the `data` folder:

```powershell
Copy-Item -Recurse data "data-backup-$(Get-Date -Format yyyyMMdd)"
```

## Before going to production

- Set `APP_ENV=production`, use a strong `PASSWORD_PEPPER`, set `SECURE_COOKIES=true` and use an `https://` `PUBLIC_ORIGIN`. The server refuses to start if any of these are missing.
- Put the server behind a reverse proxy that handles HTTPS. Set `TRUST_PROXY=true` only when that proxy is in place.
- Payments are recorded, not processed. There is no card gateway or SMS/email integration.
- SQLite suits one business with several branches on one server. For several servers, port `src/db/database.js` to PostgreSQL; it is the only file that talks to the database engine.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and what changed from v1.
