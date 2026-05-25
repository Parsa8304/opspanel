import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordEvent, verifyIngestToken } from "@/lib/billing";

export const dynamic = "force-dynamic";

const UsageObj = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    cost: z.number().optional(),
    reasoning_tokens: z.number().optional(),
    cached_tokens: z.number().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().optional() })
      .optional(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().optional() })
      .optional(),
  })
  .passthrough();

const EventSchema = z.object({
  provider: z.string().min(1),
  model: z.string().nullish(),
  endpoint: z.string().nullish(),
  generationId: z.string().nullish(),
  requestId: z.string().nullish(),
  requestAt: z.union([z.string(), z.date()]).nullish(),
  module: z.string().nullish(),
  userId: z.string().nullish(),
  projectId: z.string().nullish(),
  isByok: z.boolean().optional(),
  isFreeTier: z.boolean().optional(),
  usage: UsageObj.nullish(),
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
  tokensReasoning: z.number().optional(),
  tokensCached: z.number().optional(),
  requestMeta: z.record(z.string(), z.unknown()).nullish(),
  rawMeta: z.record(z.string(), z.unknown()).nullish(),
});

const Body = z.union([EventSchema, z.array(EventSchema).max(500)]);

function presentedToken(req: NextRequest): string | null {
  return (
    req.headers.get("x-billing-ingest-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    null
  );
}

/**
 * Ingest endpoint — protected by the shared ingest token (NOT a user JWT)
 * so the product backend can post real captured usage. Accepts a single
 * event or a batch. Returns fast; recording is fire-and-forget so the
 * caller is never blocked.
 */
export const POST = handler(async (req: NextRequest) => {
  const ok = await verifyIngestToken(presentedToken(req));
  if (!ok) throw new Response("Unauthorized", { status: 401 });

  const parsed = Body.parse(await req.json());
  const events = Array.isArray(parsed) ? parsed : [parsed];

  // Fire-and-forget: do not block the caller on DB writes / pricing.
  void Promise.allSettled(
    events.map((e) => recordEvent(e as any))
  ).catch(() => {});

  return json({ accepted: events.length }, { status: 202 });
});

/** Drill-down list with filters. READONLY+. */
export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const sp = req.nextUrl.searchParams;
  const where: any = {};
  if (sp.get("provider")) where.provider = sp.get("provider");
  if (sp.get("model")) where.model = sp.get("model");
  if (sp.get("module")) where.module = sp.get("module");
  if (sp.get("userId")) where.userId = sp.get("userId");
  if (sp.get("projectId")) where.projectId = sp.get("projectId");
  if (sp.get("byok")) where.isByok = sp.get("byok") === "true";
  if (sp.get("free")) where.isFreeTier = sp.get("free") === "true";
  if (sp.get("from") || sp.get("to")) {
    where.requestAt = {};
    if (sp.get("from")) where.requestAt.gte = new Date(sp.get("from")!);
    if (sp.get("to")) where.requestAt.lte = new Date(sp.get("to")!);
  }
  const take = Math.min(500, parseInt(sp.get("take") || "100", 10) || 100);
  const skip = parseInt(sp.get("skip") || "0", 10) || 0;
  const [rows, total] = await Promise.all([
    prisma.billingEvent.findMany({
      where,
      orderBy: { requestAt: "desc" },
      take,
      skip,
    }),
    prisma.billingEvent.count({ where }),
  ]);
  return json({ rows, total, take, skip });
});
