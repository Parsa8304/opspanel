import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json, setSetting, maskSecrets } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { getCiConfig, CI_SETTING_KEY } from "@/lib/ci";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const cfg = await getCiConfig();
  return json(maskSecrets(cfg as unknown as Record<string, unknown>));
});

const schema = z.object({
  type: z.enum(["junit_url", "none"]),
  url: z.string().optional().nullable(),
  token: z.string().optional().nullable(),
});

export const PUT = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = schema.parse(await req.json());
  const prev = await getCiConfig();

  const tokenIncoming = body.token ?? undefined;
  const tokenLooksMasked =
    typeof tokenIncoming === "string" && tokenIncoming.includes("••••");
  const token =
    tokenLooksMasked || !tokenIncoming ? prev.token : tokenIncoming;

  const next = {
    type: body.type,
    url: body.url?.trim() || undefined,
    token: token || undefined,
  };
  await setSetting(CI_SETTING_KEY, next);
  await audit(user.id, "tests.ci.config.update", CI_SETTING_KEY, {
    type: next.type,
    url: next.url ?? null,
  });
  return json(maskSecrets(next as unknown as Record<string, unknown>));
});
