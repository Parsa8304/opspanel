import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { log, GitNotConfiguredError } from "@/lib/git";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const limit = Number(
    new URL(req.url).searchParams.get("limit") || "50"
  );
  try {
    const commits = await log({ maxCount: Number.isFinite(limit) ? limit : 50 });
    return json({ configured: true, commits });
  } catch (e) {
    if (e instanceof GitNotConfiguredError)
      return json({ configured: false, error: e.message, commits: [] }, { status: 409 });
    throw e;
  }
});
