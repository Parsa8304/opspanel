// JUnit/XML ingest — HONESTY PRINCIPLE: parsed only from real ingested XML.
// Minimal, dependency-free XML parser tuned for JUnit testsuite(s) reports.

import { prisma } from "./prisma";

export type TestType =
  | "UNIT"
  | "INTEGRATION"
  | "E2E"
  | "API"
  | "FRONTEND"
  | "WORKER";
export type TestCaseStatus = "PASSED" | "FAILED" | "SKIPPED";

export interface ParsedCase {
  name: string;
  classname?: string;
  type: TestType;
  status: TestCaseStatus;
  durationMs: number;
  failureMessage?: string;
  failureTrace?: string;
}

export interface ParsedRun {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  cases: ParsedCase[];
}

// ───────────────────────── Minimal XML parser ─────────────────────────

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&amp;/g, "&");
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Parse a (well-formed enough) XML document into a tree. Handles CDATA,
 *  comments, processing instructions, self-closing tags and nesting. */
export function parseXml(input: string): XmlNode {
  let xml = input;
  // Strip BOM, XML declaration, comments, doctype, processing instructions.
  xml = xml.replace(/^﻿/, "");
  xml = xml.replace(/<\?[\s\S]*?\?>/g, "");
  xml = xml.replace(/<!--[\s\S]*?-->/g, "");
  xml = xml.replace(/<!DOCTYPE[\s\S]*?>/gi, "");

  const root: XmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      const tail = xml.slice(i).trim();
      if (tail) stack[stack.length - 1].text += decodeEntities(tail);
      break;
    }
    if (lt > i) {
      const txt = xml.slice(i, lt);
      if (txt.trim())
        stack[stack.length - 1].text += decodeEntities(txt);
    }
    // CDATA — keep raw content (used for failure traces).
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      const content =
        end === -1
          ? xml.slice(lt + 9)
          : xml.slice(lt + 9, end);
      stack[stack.length - 1].text += content;
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    const gt = xml.indexOf(">", lt);
    if (gt === -1) break;
    let tagBody = xml.slice(lt + 1, gt).trim();

    if (tagBody.startsWith("/")) {
      // Closing tag.
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }

    const selfClosing = tagBody.endsWith("/");
    if (selfClosing) tagBody = tagBody.slice(0, -1).trim();

    const spaceIdx = tagBody.search(/\s/);
    const tag = spaceIdx === -1 ? tagBody : tagBody.slice(0, spaceIdx);
    const attrRaw = spaceIdx === -1 ? "" : tagBody.slice(spaceIdx + 1);
    const node: XmlNode = {
      tag,
      attrs: parseAttrs(attrRaw),
      children: [],
      text: "",
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
}

function findAll(node: XmlNode, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

// ───────────────────────── Type inference ─────────────────────────

const TYPE_RULES: [RegExp, TestType][] = [
  [/(^|[^a-z])e2e([^a-z]|$)|end.?to.?end|cypress|playwright|selenium/i, "E2E"],
  [/integration|\bint\b|\bit\b/i, "INTEGRATION"],
  [/\bapi\b|endpoint|route|graphql|rest/i, "API"],
  [/frontend|\bui\b|component|react|render|dom|browser/i, "FRONTEND"],
  [/worker|queue|celery|job|task|async|consumer|cron/i, "WORKER"],
  [/unit/i, "UNIT"],
];

/** Infer a TestType from classname + name heuristics. Default UNIT. */
export function inferType(name: string, classname?: string): TestType {
  const hay = `${classname || ""} ${name || ""}`;
  for (const [re, type] of TYPE_RULES) if (re.test(hay)) return type;
  return "UNIT";
}

function normType(v: string | undefined): TestType | undefined {
  if (!v) return undefined;
  const u = v.trim().toUpperCase();
  if (
    u === "UNIT" ||
    u === "INTEGRATION" ||
    u === "E2E" ||
    u === "API" ||
    u === "FRONTEND" ||
    u === "WORKER"
  )
    return u as TestType;
  return undefined;
}

// ───────────────────────── JUnit parsing ─────────────────────────

export interface ParseOptions {
  /** Explicit overrides keyed by "classname#name" or just "name". */
  typeMap?: Record<string, TestType>;
}

function secToMs(v: string | undefined): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

/** Parse JUnit-style XML into a normalized run. Pure, no side effects. */
export function parseJunit(xml: string, opts: ParseOptions = {}): ParsedRun {
  const root = parseXml(xml);
  const suites = findAll(root, "testsuite");
  // If a lone <testsuites> with direct testcases, findAll still catches them.
  const cases = findAll(root, "testcase");

  const parsed: ParsedCase[] = [];
  let durTotal = 0;

  for (const tc of cases) {
    const name = tc.attrs.name || "(unnamed)";
    const classname =
      tc.attrs.classname || tc.attrs.class || undefined;
    const failNode = tc.children.find(
      (c) => c.tag === "failure" || c.tag === "error"
    );
    const skipNode = tc.children.find((c) => c.tag === "skipped");

    let status: TestCaseStatus = "PASSED";
    let failureMessage: string | undefined;
    let failureTrace: string | undefined;
    if (failNode) {
      status = "FAILED";
      failureMessage =
        failNode.attrs.message?.trim() ||
        failNode.attrs.type?.trim() ||
        undefined;
      const body = failNode.text.trim();
      if (body) failureTrace = body;
      if (!failureMessage && body)
        failureMessage = body.split("\n")[0].slice(0, 500);
    } else if (skipNode) {
      status = "SKIPPED";
    }

    const explicit =
      normType(tc.attrs.type) ||
      opts.typeMap?.[`${classname || ""}#${name}`] ||
      opts.typeMap?.[name];
    const type = explicit || inferType(name, classname);

    const durationMs = secToMs(tc.attrs.time);
    durTotal += durationMs;

    parsed.push({
      name,
      classname,
      type,
      status,
      durationMs,
      failureMessage,
      failureTrace,
    });
  }

  // Prefer explicit suite-level time when present and larger (parallel suites).
  let suiteTime = 0;
  for (const s of suites) suiteTime += secToMs(s.attrs.time);
  const durationMs = Math.max(durTotal, suiteTime);

  const passed = parsed.filter((c) => c.status === "PASSED").length;
  const failed = parsed.filter((c) => c.status === "FAILED").length;
  const skipped = parsed.filter((c) => c.status === "SKIPPED").length;

  return {
    total: parsed.length,
    passed,
    failed,
    skipped,
    durationMs,
    cases: parsed,
  };
}

// ───────────────────────── Persistence (shared by API + test) ─────────────────────────

export interface IngestMeta {
  commitSha?: string | null;
  source?: string | null;
  ciUrl?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export interface IngestResult {
  id: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  commitSha: string | null;
  source: string;
  ciUrl: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/** Persist a parsed run (from XML or a pre-normalized payload) into Postgres.
 *  This is the SINGLE code path used by both the API route and the test. */
export async function persistRun(
  run: ParsedRun,
  meta: IngestMeta = {}
): Promise<IngestResult> {
  const started = meta.startedAt ?? new Date();
  const finished =
    meta.finishedAt ??
    new Date(started.getTime() + (run.durationMs || 0));

  const created = await prisma.testRun.create({
    data: {
      commitSha: meta.commitSha || null,
      source: meta.source || "manual",
      ciUrl: meta.ciUrl || null,
      total: run.total,
      passed: run.passed,
      failed: run.failed,
      skipped: run.skipped,
      durationMs: run.durationMs,
      startedAt: started,
      finishedAt: finished,
      cases: {
        create: run.cases.map((c) => ({
          name: c.name,
          classname: c.classname || null,
          type: c.type,
          status: c.status,
          durationMs: c.durationMs,
          failureMessage: c.failureMessage || null,
          failureTrace: c.failureTrace || null,
        })),
      },
    },
  });

  return {
    id: created.id,
    total: created.total,
    passed: created.passed,
    failed: created.failed,
    skipped: created.skipped,
    durationMs: created.durationMs,
    commitSha: created.commitSha,
    source: created.source,
    ciUrl: created.ciUrl,
    startedAt: created.startedAt,
    finishedAt: created.finishedAt,
  };
}

/** Convenience: parse raw JUnit XML and persist. Used by API + test. */
export async function ingestJunit(
  xml: string,
  meta: IngestMeta = {},
  opts: ParseOptions = {}
): Promise<IngestResult> {
  const run = parseJunit(xml, opts);
  return persistRun(run, meta);
}

/** Validate/normalize a pre-parsed JSON payload into a ParsedRun. */
export function normalizePayload(p: any): ParsedRun {
  const rawCases = Array.isArray(p?.cases) ? p.cases : [];
  const cases: ParsedCase[] = rawCases.map((c: any) => {
    const status: TestCaseStatus =
      c.status === "FAILED" || c.status === "SKIPPED" ? c.status : "PASSED";
    const type =
      normType(c.type) || inferType(String(c.name || ""), c.classname);
    return {
      name: String(c.name || "(unnamed)"),
      classname: c.classname ? String(c.classname) : undefined,
      type,
      status,
      durationMs: Number.isFinite(c.durationMs) ? Math.round(c.durationMs) : 0,
      failureMessage: c.failureMessage ? String(c.failureMessage) : undefined,
      failureTrace: c.failureTrace ? String(c.failureTrace) : undefined,
    };
  });
  const passed = cases.filter((c) => c.status === "PASSED").length;
  const failed = cases.filter((c) => c.status === "FAILED").length;
  const skipped = cases.filter((c) => c.status === "SKIPPED").length;
  const durationMs = Number.isFinite(p?.durationMs)
    ? Math.round(p.durationMs)
    : cases.reduce((a, c) => a + c.durationMs, 0);
  return { total: cases.length, passed, failed, skipped, durationMs, cases };
}

// ───────────────────────── Flaky detection ─────────────────────────

export interface FlakyEntry {
  name: string;
  passCount: number;
  failCount: number;
  skipCount: number;
  totalRuns: number;
  flakiness: number; // min(pass,fail) / (pass+fail)
  lastStatus: TestCaseStatus;
  lastSeenAt: Date;
}

/** A test is flaky if it has BOTH a PASSED and a FAILED outcome in the
 *  window. Computed only from real ingested cases — never fabricated. */
export function computeFlaky(
  cases: {
    name: string;
    status: TestCaseStatus;
    testRun: { startedAt: Date };
  }[]
): FlakyEntry[] {
  const byName = new Map<
    string,
    { pass: number; fail: number; skip: number; last: Date; lastStatus: TestCaseStatus }
  >();
  for (const c of cases) {
    const e =
      byName.get(c.name) ||
      {
        pass: 0,
        fail: 0,
        skip: 0,
        last: new Date(0),
        lastStatus: "PASSED" as TestCaseStatus,
      };
    if (c.status === "PASSED") e.pass++;
    else if (c.status === "FAILED") e.fail++;
    else e.skip++;
    if (c.testRun.startedAt >= e.last) {
      e.last = c.testRun.startedAt;
      e.lastStatus = c.status;
    }
    byName.set(c.name, e);
  }
  const out: FlakyEntry[] = [];
  for (const [name, e] of Array.from(byName.entries())) {
    if (e.pass > 0 && e.fail > 0) {
      const denom = e.pass + e.fail;
      out.push({
        name,
        passCount: e.pass,
        failCount: e.fail,
        skipCount: e.skip,
        totalRuns: e.pass + e.fail + e.skip,
        flakiness: Math.min(e.pass, e.fail) / denom,
        lastStatus: e.lastStatus,
        lastSeenAt: e.last,
      });
    }
  }
  out.sort((a, b) => b.flakiness - a.flakiness || b.failCount - a.failCount);
  return out;
}
