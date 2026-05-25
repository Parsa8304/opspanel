import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { rateSample, flagSample } from "@/lib/aiquality";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    notes: z.string().optional().nullable(),
    flag: z.enum(["NONE", "HALLUCINATION", "REFUSAL", "ERROR"]).optional(),
  })
  .refine((b) => b.rating != null || b.flag != null, {
    message: "Provide a rating (1-5) and/or a flag",
  });

export const PATCH = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "REVIEWER");
    const id = ctx.params.id;
    const body = schema.parse(await req.json());
    let result: unknown = null;
    if (body.flag != null) {
      result = await flagSample(id, body.flag, user.id);
    }
    if (body.rating != null) {
      result = await rateSample(id, body.rating, body.notes ?? null, user.id);
    }
    return json(result);
  }
);
