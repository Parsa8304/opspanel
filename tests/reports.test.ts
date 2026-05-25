// Section 11 — Report Generator: REAL integration test (not mocked).
//
// Runs against the real Postgres. Docker / Redis / git may be down; we assert
// those sections degrade to honest `{unavailable:true,...}` blocks and NEVER
// to fabricated numbers. Q/A is asserted against REAL seeded data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  collectSnapshot,
  createReport,
  renderMarkdown,
  renderHtml,
  headlineMetrics,
  isUnavailable,
  ALL_SECTIONS,
  type ReportLike,
} from "../src/lib/report";

const prisma = new PrismaClient();

const createdReports: string[] = [];
const createdReg: string[] = [];
const createdCov: string[] = [];

const UNIQUE = `reptest-${Date.now()}`;

test("collectSnapshot: Q/A reflects REAL seeded RegressionItems; down sources are honest", async () => {
  // Seed expects 18 RegressionItems (all STALE, never verified) + 7 NOT_STARTED
  // CoverageItems. Add one extra known-stale item + one NOT_STARTED coverage
  // item so the gap is provably present regardless of seed drift.
  const reg = await prisma.regressionItem.create({
    data: {
      module: "OVERALL_READINESS",
      title: `${UNIQUE} stale check`,
      status: "PASSING", // stored PASSING must NOT be trusted
      lastVerifiedAt: new Date(Date.now() - 90 * 24 * 3600_000),
      staleAfterDays: 30,
      environment: "DEMO",
    },
  });
  createdReg.push(reg.id);
  const cov = await prisma.coverageItem.create({
    data: {
      title: `${UNIQUE} pending coverage`,
      area: "Testing",
      status: "NOT_STARTED",
    },
  });
  createdCov.push(cov.id);

  const totalReg = await prisma.regressionItem.count();
  const snap = await collectSnapshot(ALL_SECTIONS);

  assert.ok(snap.qa && !isUnavailable(snap.qa), "Q/A must be available (Postgres up)");
  const qa = snap.qa as any;
  assert.equal(qa.total, totalReg, "Q/A total must equal REAL row count");
  assert.ok(qa.total >= 18, `expected >=18 seeded regression items, got ${qa.total}`);

  // Our 90d-old item must be reported STALE despite stored PASSING.
  const mine = qa.items.find((i: any) => i.title === `${UNIQUE} stale check`);
  assert.ok(mine, "our seeded item must appear");
  assert.equal(mine.effectiveStatus, "STALE", "90d-old item must be STALE");
  assert.equal(mine.isStale, true);
  assert.ok(qa.stale >= 1, "at least one stale item");

  // NOT_STARTED coverage is counted, never hidden.
  assert.ok(qa.coverage.notStarted >= 1, "pending coverage tracked honestly");

  // Sources that need Docker / Redis / git: when down they MUST be unavailable
  // OR (if reachable) contain only real values — never fabricated. We assert
  // the type discipline: if unavailable, it has a reason string and no numbers.
  for (const key of ["containers"] as const) {
    const blk = (snap as any)[key];
    assert.ok(blk !== undefined, `${key} block present`);
    if (isUnavailable(blk)) {
      assert.equal(typeof blk.reason, "string");
      assert.ok(blk.reason.length > 0, "unavailable must carry an honest reason");
      assert.equal((blk as any).total, undefined, "no fabricated numbers");
    } else {
      assert.equal(typeof blk.total, "number", "real number when reachable");
    }
  }

  // Async: queues sub-block must be honest if Redis is down (not a number).
  const a = snap.async as any;
  if (!isUnavailable(a)) {
    if (!Array.isArray(a.queues)) {
      assert.equal(a.queues.unavailable, true);
      assert.equal(typeof a.queues.reason, "string");
    }
    // jobStats reads Postgres so totals is always a real object.
    assert.equal(typeof a.totals.total, "number");
  }

  // Deployments: git may be unconfigured -> honest gitNote, never invented head.
  const dep = snap.deployments as any;
  if (!isUnavailable(dep)) {
    if (dep.head == null) {
      assert.equal(typeof dep.gitNote, "string");
      assert.ok(dep.gitNote.length > 0);
    }
  }
});

test("service path: version 1, then SAME title -> version 2; v1 snapshot immutable", async () => {
  const title = `${UNIQUE} versioned`;
  const r1 = await createReport({
    title,
    mode: "INTERNAL",
    language: "EN",
    sections: ALL_SECTIONS,
  });
  createdReports.push(r1.id);
  assert.equal(r1.version, 1, "first report for a title is version 1");

  const v1SnapBefore = JSON.stringify(r1.snapshot);

  // Mutate underlying data between snapshots so v2 differs from v1.
  const extra = await prisma.regressionItem.create({
    data: {
      module: "OVERALL_READINESS",
      title: `${UNIQUE} v2-only item`,
      status: "STALE",
      environment: "DEMO",
    },
  });
  createdReg.push(extra.id);

  const r2 = await createReport({
    title,
    mode: "REVIEWER",
    language: "EN",
    sections: ALL_SECTIONS,
  });
  createdReports.push(r2.id);
  assert.equal(r2.version, 2, "same title increments version");

  // v1's stored snapshot must be byte-for-byte unchanged (immutable capture).
  const r1Reloaded = await prisma.report.findUnique({ where: { id: r1.id } });
  assert.equal(
    JSON.stringify(r1Reloaded!.snapshot),
    v1SnapBefore,
    "v1 snapshot must not change after v2 is generated"
  );

  const q1 = (r1Reloaded!.snapshot as any).qa.total;
  const q2 = (r2.snapshot as any).qa.total;
  assert.equal(q2, q1 + 1, "v2 captured the newer (larger) real count");
});

test("INTERNAL shows gaps explicitly; REVIEWER keeps SAME numbers + roadmap framing", async () => {
  // A snapshot with a known NOT_STARTED coverage gap + stale Q/A.
  const cov = await prisma.coverageItem.create({
    data: {
      title: `${UNIQUE} roadmap item`,
      area: "Security",
      status: "NOT_STARTED",
      owner: "Sara",
      deadline: new Date("2026-09-01T00:00:00.000Z"),
    },
  });
  createdCov.push(cov.id);
  const covNoDate = await prisma.coverageItem.create({
    data: {
      title: `${UNIQUE} no-date item`,
      area: "Compliance",
      status: "NOT_STARTED",
    },
  });
  createdCov.push(covNoDate.id);

  const snap = await collectSnapshot(ALL_SECTIONS);
  const baseReport: Omit<ReportLike, "mode"> = {
    title: `${UNIQUE} modes`,
    language: "EN",
    version: 1,
    createdAt: new Date("2026-05-19T12:00:00.000Z"),
    snapshot: snap,
  };
  const internal: ReportLike = { ...baseReport, mode: "INTERNAL" };
  const reviewer: ReportLike = { ...baseReport, mode: "REVIEWER" };

  const mdInternal = renderMarkdown(internal);
  const mdReviewer = renderMarkdown(reviewer);
  const htmlInternal = renderHtml(internal);

  // INTERNAL: the gap is explicit.
  assert.ok(
    mdInternal.includes("NOT DONE"),
    "INTERNAL must label pending coverage NOT DONE"
  );
  assert.ok(
    mdInternal.includes(`${UNIQUE} roadmap item`),
    "INTERNAL must list the pending item"
  );
  assert.ok(
    /STALE/.test(mdInternal),
    "INTERNAL must surface stale Q/A as STALE"
  );
  assert.ok(
    htmlInternal.includes("Source unavailable") ||
      htmlInternal.includes("gap") ||
      htmlInternal.includes("STALE"),
    "INTERNAL HTML surfaces real gaps"
  );

  // REVIEWER: roadmap framing added, with the REAL owner/deadline, and an
  // explicit "roadmap date TBD" for the item that has no deadline.
  assert.ok(
    mdReviewer.includes("Planned roadmap"),
    "REVIEWER reframes pending as roadmap"
  );
  assert.ok(
    mdReviewer.includes("Sara"),
    "REVIEWER uses the REAL owner from CoverageItem"
  );
  assert.ok(
    mdReviewer.includes("roadmap date TBD"),
    "REVIEWER says TBD instead of inventing a deadline"
  );

  // CRITICAL: identical numeric facts between modes (no metric changed).
  const hi = headlineMetrics(internal.snapshot);
  const hr = headlineMetrics(reviewer.snapshot);
  assert.deepEqual(
    hi,
    hr,
    "headline metrics must be identical (same snapshot)"
  );

  // Programmatic proof: the "**k**: v" fact tokens must match across modes.
  const facts = (s: string) =>
    (s.match(/\*\*[^*]+\*\*: [^\n·|]+/g) || []).sort();
  const fi = facts(mdInternal);
  const fr = facts(mdReviewer);
  assert.deepEqual(
    fi,
    fr,
    "every numeric fact must be byte-identical between INTERNAL and REVIEWER"
  );
  assert.ok(fi.length > 0, "there must be facts to compare");
});

test("language=FA: HTML has dir=rtl, Persian text and Persian digits/date", async () => {
  const snap = await collectSnapshot({ ...ALL_SECTIONS });
  const fa: ReportLike = {
    title: `${UNIQUE} fa`,
    mode: "INTERNAL",
    language: "FA",
    version: 7,
    createdAt: new Date("2026-05-19T12:00:00.000Z"),
    snapshot: snap,
  };
  const html = renderHtml(fa);
  assert.ok(html.includes('dir="rtl"'), "FA HTML must be RTL");
  assert.ok(html.includes('lang="fa"'), "FA HTML lang attr");
  // Persian translated section heading.
  assert.ok(
    html.includes("رگرسیون و پوشش کیفیت"),
    "FA HTML must contain Persian section text"
  );
  // Persian digits: version 7 -> ۷ ; and Persian-formatted date present.
  assert.ok(/[۰-۹]/.test(html), "FA HTML must contain Persian digits");
  assert.ok(html.includes("۷"), "version 7 rendered with Persian digit");
});

test("cleanup: remove only rows created by this test; seed intact", async () => {
  await prisma.report.deleteMany({ where: { id: { in: createdReports } } });
  await prisma.coverageItem.deleteMany({ where: { id: { in: createdCov } } });
  await prisma.regressionItem.deleteMany({ where: { id: { in: createdReg } } });

  assert.equal(
    await prisma.report.count({ where: { id: { in: createdReports } } }),
    0
  );
  assert.equal(
    await prisma.coverageItem.count({ where: { id: { in: createdCov } } }),
    0
  );
  assert.equal(
    await prisma.regressionItem.count({ where: { id: { in: createdReg } } }),
    0
  );

  // Seeded Q/A data still present.
  const reg = await prisma.regressionItem.count();
  assert.ok(reg >= 18, `expected >=18 seeded regression items, got ${reg}`);

  await prisma.$disconnect();
});
