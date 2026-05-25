import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createReport, findChromium } from "@/lib/report";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "REVIEWER");
  const reports = await prisma.report.findMany({
    orderBy: [{ title: "asc" }, { version: "desc" }],
    select: {
      id: true,
      title: true,
      mode: true,
      language: true,
      version: true,
      createdAt: true,
      createdBy: { select: { name: true } },
    },
  });
  return json({ reports, pdfAvailable: !!findChromium() });
});

const createSchema = z.object({
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

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "REVIEWER");
  const body = createSchema.parse(await req.json());
  const report = await createReport({
    title: body.title,
    mode: body.mode,
    language: body.language,
    sections: body.sections,
    createdById: user.id,
  });
  await audit(user.id, "report.generate", report.id, {
    title: report.title,
    mode: report.mode,
    language: report.language,
    version: report.version,
  });
  return json(
    { id: report.id, title: report.title, version: report.version },
    { status: 201 }
  );
});
