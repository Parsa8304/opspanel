import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { getCiConfig, fetchCiJunit, CiNotConfiguredError } from "@/lib/ci";
import { ingestJunit } from "@/lib/junit";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const cfg = await getCiConfig();
  let xml: string;
  try {
    xml = await fetchCiJunit(cfg);
  } catch (e) {
    if (e instanceof CiNotConfiguredError)
      throw new Response(
        JSON.stringify({ error: e.message, configured: false }),
        { status: 400 }
      );
    throw new Response(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Pull failed",
      }),
      { status: 502 }
    );
  }
  const result = await ingestJunit(xml, {
    source: "ci",
    ciUrl: cfg.url || null,
  });
  await audit(user.id, "tests.ci.pull", result.id, {
    total: result.total,
    failed: result.failed,
  });
  return json(result, { status: 201 });
});
