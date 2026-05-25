import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  renderMarkdown,
  renderHtml,
  renderPdf,
  type ReportLike,
} from "@/lib/report";

export const dynamic = "force-dynamic";

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report"
  );
}

export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "REVIEWER");
    const url = new URL(req.url);
    const format = (url.searchParams.get("format") || "html").toLowerCase();
    const print = url.searchParams.get("print") === "1";

    const row = await prisma.report.findUnique({
      where: { id: ctx.params.id },
      include: { createdBy: { select: { name: true } } },
    });
    if (!row) throw new Response("Not found", { status: 404 });

    // Re-render strictly from the STORED immutable snapshot, never live data.
    const report: ReportLike = {
      title: row.title,
      mode: row.mode as any,
      language: row.language as any,
      version: row.version,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      snapshot: row.snapshot as any,
    };
    const base = `${slug(row.title)}-v${row.version}`;

    if (format === "md") {
      const md = renderMarkdown(report);
      return new Response(md, {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${base}.md"`,
        },
      });
    }

    if (format === "html") {
      const html = renderHtml(report, { print });
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...(print
            ? {}
            : {
                "content-disposition": `attachment; filename="${base}.html"`,
              }),
        },
      });
    }

    if (format === "pdf") {
      const result = await renderPdf(report);
      if (!result.available || !result.pdf) {
        // HONEST: no fabricated PDF. Offer the real alternatives.
        return json(
          {
            error: "pdf_unavailable",
            reason: result.reason,
            alternatives: {
              html: `/api/reports/${row.id}/export?format=html`,
              htmlPrint: `/api/reports/${row.id}/export?format=html&print=1`,
              markdown: `/api/reports/${row.id}/export?format=md`,
            },
          },
          { status: 501 }
        );
      }
      return new Response(new Uint8Array(result.pdf), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${base}.pdf"`,
        },
      });
    }

    throw new Response("Unknown format (use md|html|pdf)", { status: 400 });
  }
);
