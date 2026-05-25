import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { tags, GitNotConfiguredError } from "@/lib/git";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  try {
    return json({ configured: true, tags: await tags() });
  } catch (e) {
    if (e instanceof GitNotConfiguredError)
      return json({ configured: false, error: e.message, tags: [] }, { status: 409 });
    throw e;
  }
});
