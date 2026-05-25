import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listContainers,
  statsSnapshot,
  groupByCompose,
  docker,
  demuxDockerStream,
} from "../src/lib/docker";
import type { Readable } from "stream";

test("lists at least one real container", async () => {
  const list = await listContainers();
  assert.ok(Array.isArray(list), "result is an array");
  assert.ok(list.length >= 1, `expected >=1 container, got ${list.length}`);
});

test("finds panel-postgres container", async () => {
  const list = await listContainers();
  const pg = list.find((c) => c.name === "panel-postgres");
  assert.ok(pg, "panel-postgres not found");
  assert.equal(pg!.state, "running", "panel-postgres should be running");
  assert.ok(pg!.image.includes("postgres"), "image should be postgres");
});

test("fetches a stats snapshot with numeric cpu/mem", async () => {
  const list = await listContainers();
  const pg = list.find((c) => c.name === "panel-postgres")!;
  const s = await statsSnapshot(pg.id);
  assert.equal(typeof s.cpuPercent, "number");
  assert.equal(typeof s.memUsage, "number");
  assert.equal(typeof s.memLimit, "number");
  assert.ok(Number.isFinite(s.cpuPercent), "cpuPercent finite");
  assert.ok(s.memUsage > 0, "memUsage should be > 0 for a running container");
});

test("tails real logs for panel-postgres (non-empty)", async () => {
  const list = await listContainers();
  const pg = list.find((c) => c.name === "panel-postgres")!;
  const stream = (await docker.getContainer(pg.id).logs({
    stdout: true,
    stderr: true,
    tail: 50,
    timestamps: true,
    follow: false,
  } as any)) as unknown as Buffer | Readable;

  let buf: Buffer;
  if (Buffer.isBuffer(stream)) {
    buf = stream;
  } else {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      (stream as Readable).on("data", (c) => chunks.push(Buffer.from(c)));
      (stream as Readable).on("end", () => resolve());
      (stream as Readable).on("error", reject);
    });
    buf = Buffer.concat(chunks);
  }
  const text = demuxDockerStream(buf);
  assert.ok(text.trim().length > 0, "expected non-empty logs for panel-postgres");
});

test("groups containers by compose project", async () => {
  const { projects, ungrouped } = await groupByCompose();
  assert.ok(Array.isArray(projects));
  assert.ok(Array.isArray(ungrouped));
  const total =
    projects.reduce(
      (a, p) => a + p.services.reduce((b, s) => b + s.containers.length, 0),
      0
    ) + ungrouped.length;
  assert.ok(total >= 1, "grouped view should include >=1 container");
});
