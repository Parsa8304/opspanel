import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json, setSetting, maskSecrets } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { getGitConfig, GIT_SETTING_KEY } from "@/lib/git";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const cfg = await getGitConfig();
  return json(maskSecrets(cfg as unknown as Record<string, unknown>));
});

const schema = z.object({
  provider: z.enum(["github", "gitlab", "gitea", "local"]),
  repoPath: z.string().optional().nullable(),
  repoUrl: z.string().optional().nullable(),
  branch: z.string().optional().nullable(),
  token: z.string().optional().nullable(),
});

export const PUT = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = schema.parse(await req.json());
  const prev = await getGitConfig();

  // Preserve existing token unless a new (non-masked) one is supplied.
  const tokenIncoming = body.token ?? undefined;
  const tokenLooksMasked =
    typeof tokenIncoming === "string" && tokenIncoming.includes("••••");
  const token = tokenLooksMasked || !tokenIncoming ? prev.token : tokenIncoming;

  const next = {
    provider: body.provider,
    repoPath: body.repoPath?.trim() || undefined,
    repoUrl: body.repoUrl?.trim() || undefined,
    branch: body.branch?.trim() || undefined,
    token: token || undefined,
  };
  await setSetting(GIT_SETTING_KEY, next);
  await audit(user.id, "git.config.update", GIT_SETTING_KEY, {
    provider: next.provider,
    repoPath: next.repoPath ?? null,
  });
  return json(maskSecrets(next as unknown as Record<string, unknown>));
});
