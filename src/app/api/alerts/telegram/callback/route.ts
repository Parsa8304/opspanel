import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { handleTelegramCallback } from "@/lib/alerts";

export const dynamic = "force-dynamic";

/**
 * Telegram inline-button callback (webhook). Public-ish: Telegram posts
 * here. We verify the update shape and map to ack/snooze. Honest no-op
 * (200, handled:false) when the event/action is unknown.
 */
export const POST = handler(async (req: NextRequest) => {
  const update = await req.json().catch(() => null);
  if (!update || typeof update !== "object")
    return json({ ok: true, handled: false });
  const r = await handleTelegramCallback(update);
  return json({ ok: true, ...r });
});

export const GET = handler(async () => json({ ok: true, handled: false }));
