import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { runRegression, AiProviderNotConfiguredError } from "@/lib/aiquality";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    const id = ctx.params.id;
    try {
      const run = await runRegression(id);
      await audit(user.id, "aiquality.regression.run", id, {
        model: run.model,
        matchScore: run.matchScore,
      });
      return json(run, { status: 201 });
    } catch (e) {
      if (e instanceof AiProviderNotConfiguredError) {
        return json(
          { error: e.message, code: "PROVIDER_NOT_CONFIGURED" },
          { status: 409 }
        );
      }
      return json(
        { error: e instanceof Error ? e.message : "Run failed" },
        { status: 502 }
      );
    }
  }
);
