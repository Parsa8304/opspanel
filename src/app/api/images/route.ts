import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { listImages, pullImage } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const images = await listImages();
  return json(images);
});

export const POST = handler(async (req: NextRequest) => {
  await requireRole(req, "ENGINEER");
  const { image } = await req.json();
  if (!image || typeof image !== "string") {
    return new Response(JSON.stringify({ error: "image required" }), { status: 400 });
  }
  await pullImage(image);
  return json({ ok: true });
});
