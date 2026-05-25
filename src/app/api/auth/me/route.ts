import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { handler } from "@/lib/api";

export const GET = handler(async (req: NextRequest) => {
  const u = await getSession(req);
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(u);
});
