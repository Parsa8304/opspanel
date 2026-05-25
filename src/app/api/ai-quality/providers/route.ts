import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json, setSetting } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  AI_PROVIDERS_SETTING_KEY,
  getProvidersConfigMasked,
} from "@/lib/aiquality";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  return json(await getProvidersConfigMasked());
});

const entry = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  pricePer1kIn: z.number().min(0).optional(),
  pricePer1kOut: z.number().min(0).optional(),
});

const schema = z.object({
  active: z.enum(["openrouter", "gemini", "custom"]).optional(),
  providers: z.object({
    openrouter: entry.optional(),
    gemini: entry.optional(),
    custom: entry.optional(),
  }),
});

export const PUT = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = schema.parse(await req.json());
  await setSetting(AI_PROVIDERS_SETTING_KEY, body);
  await audit(user.id, "aiquality.providers.update", AI_PROVIDERS_SETTING_KEY, {
    active: body.active,
    providers: Object.keys(body.providers || {}),
  });
  return json(await getProvidersConfigMasked());
});
