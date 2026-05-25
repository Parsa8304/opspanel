import { NextRequest } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import {
  collectSnapshot,
  renderHtml,
  type ReportLike,
} from "@/lib/report";

export const dynamic = "force-dynamic";

const schema = z.object({
  title: z.string().min(1).max(200),
  mode: z.enum(["INTERNAL", "REVIEWER"]),
  language: z.enum(["EN", "FA"]),
  sections: z.object({
    qa: z.boolean(),
    containers: z.boolean(),
    integrations: z.boolean(),
    async: z.boolean(),
    deployments: z.boolean(),
    tests: z.boolean(),
    benchmarks: z.boolean(),
    aiQuality: z.boolean(),
    access: z.boolean(),
  }),
});

/**
 * Live preview: captures a fresh snapshot and renders HTML WITHOUT persisting.
 * Same renderer used for stored reports, so preview == saved output.
 */
export const POST = handler(async (req: NextRequest) => {
  await requireRole(req, "REVIEWER");
  const body = schema.parse(await req.json());
  const snapshot = await collectSnapshot(body.sections);
  const report: ReportLike = {
    title: body.title,
    mode: body.mode,
    language: body.language,
    version: 0,
    createdAt: new Date(),
    snapshot,
  };
  const html = renderHtml(report);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
