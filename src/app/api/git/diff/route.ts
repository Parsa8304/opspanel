import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { diff, GitNotConfiguredError } from "@/lib/git";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const sp = new URL(req.url).searchParams;
  const a = sp.get("a");
  const b = sp.get("b");
  if (!a || !b)
    return json({ error: "Both refs 'a' and 'b' are required." }, { status: 400 });
  try {
    return json({ configured: true, diff: await diff(a, b) });
  } catch (e) {
    if (e instanceof GitNotConfiguredError)
      return json({ configured: false, error: e.message }, { status: 409 });
    throw e;
  }
});
