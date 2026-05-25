import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { ingestJunit, persistRun, normalizePayload } from "@/lib/junit";

export const dynamic = "force-dynamic";

const jsonPayload = z.object({
  xml: z.string().optional(),
  payload: z
    .object({
      durationMs: z.number().optional(),
      cases: z.array(z.any()),
    })
    .optional(),
  commitSha: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  ciUrl: z.string().optional().nullable(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const ct = req.headers.get("content-type") || "";

  let result;
  let kind = "xml";

  if (ct.includes("application/json")) {
    const body = jsonPayload.parse(await req.json());
    const meta = {
      commitSha: body.commitSha ?? null,
      source: body.source ?? "manual",
      ciUrl: body.ciUrl ?? null,
    };
    if (body.xml) {
      result = await ingestJunit(body.xml, meta);
    } else if (body.payload) {
      kind = "json";
      result = await persistRun(normalizePayload(body.payload), meta);
    } else {
      throw new Response(
        JSON.stringify({ error: "Provide xml or payload" }),
        { status: 400 }
      );
    }
  } else {
    // Raw XML text body. Meta via query string.
    const xml = await req.text();
    if (!xml.trim())
      throw new Response(JSON.stringify({ error: "Empty body" }), {
        status: 400,
      });
    const u = new URL(req.url);
    result = await ingestJunit(xml, {
      commitSha: u.searchParams.get("commit"),
      source: u.searchParams.get("source") || "manual",
      ciUrl: u.searchParams.get("ciUrl"),
    });
  }

  await audit(user.id, "tests.ingest", result.id, {
    kind,
    total: result.total,
    failed: result.failed,
  });
  return json(result, { status: 201 });
});
