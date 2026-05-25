import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { getBillingConfig, ensureIngestToken } from "@/lib/billing";
import { maskSecret } from "@/lib/crypto";
import { setSetting } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Returns config with the ingest token MASKED. The full token is only ever
 * shown once, at generation time via ?reveal=true (ADMIN+).
 */
export const GET = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ENGINEER");
  const reveal =
    req.nextUrl.searchParams.get("reveal") === "true" && u.role === "ADMIN";
  // Generate the token on first read so it exists for the product backend.
  const token = await ensureIngestToken();
  const cfg = await getBillingConfig();
  return json({
    balancePollSec: cfg.balancePollSec,
    reconThresholdPct: cfg.reconThresholdPct,
    reconThresholdUsd: cfg.reconThresholdUsd,
    providerBaseUrls: cfg.providerBaseUrls,
    paused: cfg.paused || {},
    ingestToken: reveal ? token : maskSecret(token),
    ingestTokenRevealed: reveal,
  });
});

const Body = z.object({
  balancePollSec: z.number().int().min(30).optional(),
  reconThresholdPct: z.number().nonnegative().optional(),
  reconThresholdUsd: z.number().nonnegative().optional(),
  providerBaseUrls: z.record(z.string(), z.string()).optional(),
  regenerateIngestToken: z.boolean().optional(),
});

export const PUT = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const b = Body.parse(await req.json());
  const cur = await getBillingConfig();
  if (!cur.ingestToken) cur.ingestToken = await ensureIngestToken();

  let revealedToken: string | undefined;
  if (b.regenerateIngestToken) {
    let s = "";
    for (let i = 0; i < 48; i++)
      s += Math.floor(Math.random() * 16).toString(16);
    cur.ingestToken = "bilg_" + s;
    revealedToken = cur.ingestToken;
  }

  const next = {
    ...cur,
    ...(b.balancePollSec != null
      ? { balancePollSec: b.balancePollSec }
      : {}),
    ...(b.reconThresholdPct != null
      ? { reconThresholdPct: b.reconThresholdPct }
      : {}),
    ...(b.reconThresholdUsd != null
      ? { reconThresholdUsd: b.reconThresholdUsd }
      : {}),
    providerBaseUrls: {
      ...cur.providerBaseUrls,
      ...(b.providerBaseUrls || {}),
    },
  };
  await setSetting("billing", next);
  await audit(u.id, "billing.config.update", "billing", {
    regenerated: !!b.regenerateIngestToken,
  });
  return json({
    saved: true,
    // Show the new token ONCE on regenerate; masked otherwise.
    ingestToken: revealedToken ?? maskSecret(cur.ingestToken),
    ingestTokenRevealed: !!revealedToken,
  });
});
