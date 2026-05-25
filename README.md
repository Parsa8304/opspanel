# Market Navigator — Internal Tracking & Deployment Panel

Internal panel for **Market Navigator v2 (karefun.ai)**. Operationalizes the static
internal review into a live tool: Q/A status, deployment state, container health,
versions, test results, code quality, AI output quality, and stakeholder reports.

**Honesty principle:** the panel never fabricates data. Unconfigured integrations,
unreachable services, and un-reverified Q/A items show honest empty / stale / red
states. If it hasn't been checked, it does not show green.

## Stack

Next.js 14 (App Router, TS) · Tailwind (dark-first, EN/FA + RTL) · Prisma 6 +
PostgreSQL · JWT auth (ADMIN > ENGINEER > REVIEWER > READONLY) · dockerode ·
simple-git · ioredis · recharts · puppeteer-core (PDF).

## Prerequisites

- Node 20+, Docker (the Docker socket is read for container monitoring)
- Postgres + Redis run as containers via `docker-compose.yml` (`panel-postgres`
  on `:5544`, `panel-redis` on `:6390`)

## Setup

```bash
docker compose up -d              # starts panel-postgres + panel-redis
cp .env.example .env              # then set JWT_SECRET (DATABASE_URL is preset)
npm install
npx prisma db push                # create schema
npm run seed                      # users + 18 Q/A items (STALE) + 7 gaps + integrations
npm run build && npm start        # or: npm run dev
```

Seeded logins (password `admin1234`): `admin@karefun.ai` (ADMIN),
`engineer@karefun.ai` (ENGINEER), `reviewer@karefun.ai` (REVIEWER).

## Sections

1. **Overview** — composite readiness score, active alerts, real trend sparklines
2. **Q/A Tracking** — 18 regression items (auto-stale) + 7 pending-coverage gaps
3. **Containers** — live Docker: stats, logs (SSE), exec, compose grouping
4. **Integrations Health** — real test-connection, success/latency/quota, incidents
5. **Async Pipeline** — Celery/Redis queue depth, job stats, dead-letter, SSE stream
6. **Versions & Deploy** — git-integrated history, env matrix, releases, rollback
7. **Test Logs** — JUnit ingest, flow viz, flaky detection, coverage trend
8. **Code Benchmarks** — LOC/complexity/dupe/lint/type, API p50/95/99, AI cost
9. **AI Quality** — sample log + human rating, regression re-run, review queue
10. **Access & Audit** — users/roles, access scenarios, append-only audit log
11. **Reports** — bilingual EN/FA, Internal vs Reviewer mode, versioned, MD/HTML/PDF

### Phase 2 (sections 12–17)

12. **Billing & Cost** — real OpenRouter-style usage ingest, versioned pricing, budgets, live credit balance, nightly reconciliation vs provider activity
13. **Alerts** — Telegram/webhook alerting, log-based error detection rules, real delivery status (queued on failure, never faked), inline ack/snooze
14. **Discovery** — auto-discovery of services/dependencies from real Docker + compose parse + network probes; proposes config (human ADMIN must accept)
15. **Port Map** — real `ss`/`netstat`/Docker port observation per host, conflict + public-exposure findings, stale allocation history
16. **Deploy** — orchestrated deploy runs (blue/green, rolling, recreate) with migration detection, health gating, rollback (`Deployment` stays record-of-truth)
17. **Migration** — host-to-host service/data migration plans via ansible-runner (snapshot/replicate/dump-restore), preflight, rollback, commit

The Overview/Home dashboard surfaces Phase 2 health signals (cost & billing,
open alerts + delivery health, deploy/migration status, port conflicts / public
exposure / pending discovery proposals) — all from real Phase 2 data, with
honest "unavailable / none" states when a source is unconfigured.

## Configuration

Every external endpoint is configurable in-app (Settings / per-section editors),
stored in the `Setting` table — nothing hard-coded: git repo, CI JUnit URL,
Redis URL, integration endpoints/keys, AI providers, benchmark targets.

### Phase 2 environment & tooling

- **`PANEL_MASTER_KEY`** (required, already in `.env`): the at-rest encryption
  key for secrets stored by Phase 2 — provider management/inference credentials,
  Telegram bot tokens, webhook configs, and remote-host SSH keys are encrypted
  with this key (`src/lib/crypto.ts`) and never stored in plaintext. Without it,
  encrypted secrets cannot be decrypted and the affected source reports an
  honest "unavailable" rather than failing silently.
- **`PANEL_LOCAL_HOST`** (optional): logical name for the local host used by the
  Port Map / Migration sections (defaults to `local`).
- **ansible / ansible-runner**: section 17 (Migration) shells out to
  `ansible-runner` to execute host-to-host migration playbooks; the host running
  the panel needs `ansible` + `ansible-runner` installed for live migrations
  (absent → migration runs report an honest failure, nothing fabricated).
- **Product billing wrappers**: `wrappers/openrouter_billing.py` (Python) and
  `wrappers/openrouterBilling.ts` (TypeScript) are drop-in wrappers the product
  side uses around its OpenRouter calls — they POST the real provider `usage`
  object to the panel's billing ingest endpoint (authenticated with the
  per-deployment ingest token) so section 12 records real cost from real
  responses. They honor the billing pause flag set on a 100% budget breach.

The `docker compose` services are unchanged (`panel-postgres` on `:5544`,
`panel-redis` on `:6390`); Phase 2 adds no new compose services.

## Tests

Each section ships a **real integration test** (no mocks) against the real
underlying service — real Docker daemon, real Postgres, real Redis, real git,
real HTTP/LLM endpoints.

```bash
npm test                 # runs all 17 suites (needs panel-postgres + panel-redis up)
npm run test:containers  # Phase 1: qa deployments tests async integrations
                         #   benchmarks aiquality access reports overview
npm run test:billing     # Phase 2: discovery ports alerts billing deploy migration
```

Suites (17 total): Phase 1 — containers, qa, deployments, tests, async,
integrations, benchmarks, aiquality, access, reports, overview (**73 passing**);
Phase 2 — discovery (7), ports (6), alerts (7), billing (15), deploy (6),
migration (6) (**47 passing**).

Current status: **120/120 passing** (Section 1 Overview suite unchanged and
still green after the Phase 2 signal additions).
