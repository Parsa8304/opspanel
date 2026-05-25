import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { tags, changelogBetween, GitNotConfiguredError } from "@/lib/git";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const items = await prisma.release.findMany({
    orderBy: { date: "desc" },
    include: { deployedBy: { select: { id: true, name: true } } },
  });
  return json(items);
});

const createSchema = z.object({
  version: z.string().min(1),
  commitSha: z.string().min(4),
  changelog: z.string().optional().nullable(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = createSchema.parse(await req.json());

  let changelog = body.changelog?.trim() || null;

  // Auto-generate from tag range only when not supplied and tags exist.
  if (!changelog) {
    try {
      const tagList = await tags();
      if (tagList.length > 0) {
        // Pick the most recent existing tag as the previous boundary.
        const prev = tagList[0];
        const subjects = await changelogBetween(prev.name, body.commitSha);
        if (subjects.length > 0) {
          changelog =
            `Changes since ${prev.name}:\n` +
            subjects.map((s) => `- ${s}`).join("\n");
        }
      }
    } catch (e) {
      if (!(e instanceof GitNotConfiguredError)) throw e;
      // Git not configured — leave changelog null (honest, no fabrication).
    }
  }

  const rel = await prisma.release.create({
    data: {
      version: body.version,
      commitSha: body.commitSha,
      changelog,
      deployedById: user.id,
    },
    include: { deployedBy: { select: { id: true, name: true } } },
  });
  await audit(user.id, "release.create", rel.id, {
    version: rel.version,
    commitSha: rel.commitSha,
    autoChangelog: !body.changelog && !!changelog,
  });
  return json(rel, { status: 201 });
});
