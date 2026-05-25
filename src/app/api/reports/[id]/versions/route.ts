import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { diffHeadlines, type ReportSnapshot } from "@/lib/report";

export const dynamic = "force-dynamic";

/**
 * All versions sharing this report's title (for the "Nov vs now"
 * comparison). Optionally diff two versions' headline metrics via
 * ?a=<version>&b=<version> — proving what changed between snapshots.
 */
export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "REVIEWER");
    const ref = await prisma.report.findUnique({
      where: { id: ctx.params.id },
      select: { title: true },
    });
    if (!ref) throw new Response("Not found", { status: 404 });

    const versions = await prisma.report.findMany({
      where: { title: ref.title },
      orderBy: { version: "asc" },
      select: {
        id: true,
        version: true,
        mode: true,
        language: true,
        createdAt: true,
        createdBy: { select: { name: true } },
      },
    });

    const url = new URL(req.url);
    const aV = url.searchParams.get("a");
    const bV = url.searchParams.get("b");
    let diff: ReturnType<typeof diffHeadlines> | null = null;
    if (aV && bV) {
      const [a, b] = await Promise.all([
        prisma.report.findFirst({
          where: { title: ref.title, version: Number(aV) },
          select: { snapshot: true },
        }),
        prisma.report.findFirst({
          where: { title: ref.title, version: Number(bV) },
          select: { snapshot: true },
        }),
      ]);
      if (a && b) {
        diff = diffHeadlines(
          a.snapshot as unknown as ReportSnapshot,
          b.snapshot as unknown as ReportSnapshot
        );
      }
    }

    return json({ title: ref.title, versions, diff });
  }
);
