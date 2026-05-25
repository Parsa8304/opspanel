import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { simpleGit } from "simple-git";
import { log, diff, currentHead, GitNotConfiguredError } from "../src/lib/git";
import { GIT_SETTING_KEY } from "../src/lib/git";

const prisma = new PrismaClient();

let tmp = "";
const createdDeployments: string[] = [];
const createdReleases: string[] = [];
let hadSettingBefore = false;
let prevSetting: any = null;

test("setup: real temp git repo + git Setting in real Postgres", async () => {
  // Preserve any existing git Setting so we restore it on cleanup.
  const existing = await prisma.setting.findUnique({
    where: { key: GIT_SETTING_KEY },
  });
  if (existing) {
    hadSettingBefore = true;
    prevSetting = existing.value;
  }

  tmp = mkdtempSync(join(tmpdir(), "panel-git-test-"));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig("user.email", "test@panel.local");
  await g.addConfig("user.name", "Panel Test");
  await g.addConfig("commit.gpgsign", "false");

  writeFileSync(join(tmp, "a.txt"), "alpha\n");
  await g.add("a.txt");
  await g.commit("first commit");

  writeFileSync(join(tmp, "b.txt"), "beta\n");
  await g.add("b.txt");
  await g.commit("second commit");

  writeFileSync(join(tmp, "a.txt"), "alpha changed\n");
  writeFileSync(join(tmp, "c.txt"), "gamma\n");
  await g.add(".");
  await g.commit("third commit");

  await prisma.setting.upsert({
    where: { key: GIT_SETTING_KEY },
    create: {
      key: GIT_SETTING_KEY,
      value: { provider: "local", repoPath: tmp },
    },
    update: { value: { provider: "local", repoPath: tmp } },
  });
});

test("log() returns the real commits newest-first with messages", async () => {
  const commits = await log({ maxCount: 10 });
  assert.equal(commits.length, 3);
  assert.equal(commits[0].message, "third commit");
  assert.equal(commits[1].message, "second commit");
  assert.equal(commits[2].message, "first commit");
  assert.match(commits[0].sha, /^[0-9a-f]{40}$/);
  assert.equal(commits[0].shortSha.length, 8);
  assert.equal(commits[0].author, "Panel Test");
  // Third commit changed a.txt and added c.txt.
  assert.ok(commits[0].changedFiles.includes("a.txt"));
  assert.ok(commits[0].changedFiles.includes("c.txt"));
});

test("currentHead() points at the third commit", async () => {
  const head = await currentHead();
  const commits = await log({ maxCount: 1 });
  assert.equal(head.sha, commits[0].sha);
});

test("diff() between first and third commit lists changed files", async () => {
  const commits = await log({ maxCount: 10 });
  const first = commits[2].sha;
  const third = commits[0].sha;
  const d = await diff(first, third);
  const files = d.files.map((f) => f.file).sort();
  // a.txt modified, b.txt + c.txt added between commit1..commit3.
  assert.deepEqual(files, ["a.txt", "b.txt", "c.txt"]);
  assert.equal(d.summary.files, 3);
  assert.ok(d.summary.insertions >= 3);
});

test("create a Deployment and read it back via matrix logic (real Postgres)", async () => {
  const commits = await log({ maxCount: 1 });
  const sha = commits[0].sha;

  // Supersede any previous active DEMO deployment, mirroring the API.
  await prisma.deployment.updateMany({
    where: { environment: "DEMO", status: "active" },
    data: { status: "superseded" },
  });
  const dep = await prisma.deployment.create({
    data: {
      environment: "DEMO",
      commitSha: sha,
      version: "v-test-1",
      status: "active",
    },
  });
  createdDeployments.push(dep.id);

  const active = await prisma.deployment.findFirst({
    where: { environment: "DEMO", status: "active" },
    orderBy: { deployedAt: "desc" },
  });
  assert.ok(active);
  assert.equal(active!.id, dep.id);
  assert.equal(active!.commitSha, sha);
  assert.equal(active!.version, "v-test-1");
});

test("create a Release then a rollback Deployment with rollbackOfId set", async () => {
  const commits = await log({ maxCount: 10 });
  const head = commits[0].sha;
  const prev = commits[1].sha;

  const release = await prisma.release.create({
    data: {
      version: `test-rel-${Date.now()}`,
      commitSha: head,
      changelog: "- third commit\n- second commit",
    },
  });
  createdReleases.push(release.id);
  assert.ok(release.id);
  assert.equal(release.commitSha, head);

  // The deployment we want to roll back to (older commit).
  const target = await prisma.deployment.create({
    data: {
      environment: "STAGING",
      commitSha: prev,
      version: "v-old",
      status: "superseded",
    },
  });
  createdDeployments.push(target.id);

  const rollback = await prisma.deployment.create({
    data: {
      environment: "STAGING",
      commitSha: target.commitSha,
      version: target.version,
      status: "active",
      rollbackOfId: target.id,
    },
  });
  createdDeployments.push(rollback.id);

  assert.equal(rollback.rollbackOfId, target.id);
  assert.equal(rollback.commitSha, prev);
  assert.equal(rollback.status, "active");
});

test("HONESTY: git lib throws GitNotConfiguredError when repoPath unset", async () => {
  await prisma.setting.upsert({
    where: { key: GIT_SETTING_KEY },
    create: { key: GIT_SETTING_KEY, value: { provider: "local" } },
    update: { value: { provider: "local" } },
  });
  await assert.rejects(
    () => log({ maxCount: 1 }),
    (e: unknown) => e instanceof GitNotConfiguredError
  );
});

test("cleanup: remove temp repo, created rows, restore Setting", async () => {
  await prisma.deployment.deleteMany({
    where: { id: { in: createdDeployments } },
  });
  await prisma.release.deleteMany({
    where: { id: { in: createdReleases } },
  });

  if (hadSettingBefore) {
    await prisma.setting.update({
      where: { key: GIT_SETTING_KEY },
      data: { value: prevSetting },
    });
  } else {
    await prisma.setting
      .delete({ where: { key: GIT_SETTING_KEY } })
      .catch(() => {});
  }

  if (tmp) rmSync(tmp, { recursive: true, force: true });

  const leftDep = await prisma.deployment.count({
    where: { id: { in: createdDeployments } },
  });
  const leftRel = await prisma.release.count({
    where: { id: { in: createdReleases } },
  });
  assert.equal(leftDep, 0);
  assert.equal(leftRel, 0);

  await prisma.$disconnect();
});
