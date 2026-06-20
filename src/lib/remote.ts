import { NodeSSH } from "node-ssh";
import { prisma } from "./prisma";
import { decryptSecret } from "./crypto";

/**
 * Remote-server SSH execution, mirroring the shape of hostExec/hostSpawn in
 * server.ts but targeting an arbitrary registered RemoteServer over SSH
 * instead of the local host via nsenter. Connects fresh per call — these are
 * low-frequency, human-triggered actions, not a hot path, so pooling isn't
 * worth the complexity.
 */

export class RemoteServerNotFound extends Error {
  constructor(id: string) {
    super(`Remote server ${id} not found`);
  }
}

async function loadServer(id: string) {
  const server = await prisma.remoteServer.findUnique({ where: { id } });
  if (!server) throw new RemoteServerNotFound(id);
  return server;
}

async function connect(server: {
  host: string;
  port: number;
  sshUser: string;
  privateKey: string;
  passphrase: string | null;
}): Promise<NodeSSH> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: server.host,
    port: server.port,
    username: server.sshUser,
    privateKey: decryptSecret(server.privateKey),
    passphrase: server.passphrase ? decryptSecret(server.passphrase) : undefined,
    readyTimeout: 15000,
  });
  return ssh;
}

/** Test connectivity to a server, updating lastOkAt/lastError. Returns the host key fingerprint when available. */
export async function testConnection(serverId: string): Promise<{ ok: boolean; message: string }> {
  const server = await loadServer(serverId);
  let ssh: NodeSSH | null = null;
  try {
    ssh = await connect(server);
    const result = await ssh.execCommand("uname -a && whoami");
    if (result.code !== 0 && result.code !== null) {
      throw new Error(result.stderr || `exited with code ${result.code}`);
    }
    await prisma.remoteServer.update({
      where: { id: serverId },
      data: { lastOkAt: new Date(), lastError: null },
    });
    return { ok: true, message: result.stdout.trim() };
  } catch (e: any) {
    const message = e?.message || String(e);
    await prisma.remoteServer
      .update({ where: { id: serverId }, data: { lastError: message } })
      .catch(() => {});
    return { ok: false, message };
  } finally {
    ssh?.dispose();
  }
}

/** Run a command on a remote server and wait for it to finish (buffered output). */
export async function remoteExec(
  serverId: string,
  cmd: string,
  timeoutMs = 15000
): Promise<{ stdout: string; stderr: string; code: number }> {
  const server = await loadServer(serverId);
  const ssh = await connect(server);
  try {
    const result = await Promise.race([
      ssh.execCommand(cmd),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      ),
    ]);
    return { stdout: result.stdout, stderr: result.stderr, code: result.code ?? 0 };
  } finally {
    ssh.dispose();
  }
}

/** HTTP probe from a remote server's perspective, using its own curl. */
export async function remoteFetch(
  serverId: string,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  timeoutSec = 8
): Promise<{ ok: boolean; statusCode: number; body: string; latencyMs: number }> {
  const t0 = Date.now();
  const bodyArgs = body ? `-H 'Content-Type: application/json' -d @/tmp/_hf_req` : "";
  const writeBody = body ? `printf '%s' ${JSON.stringify(JSON.stringify(body))} > /tmp/_hf_req && ` : "";
  const cmd = `${writeBody}curl -s -o /tmp/_hf_body -w '%{http_code}' --max-time ${timeoutSec} -X ${method} ${bodyArgs} ${JSON.stringify(url)} && cat /tmp/_hf_body`;
  try {
    const result = await remoteExec(serverId, cmd, (timeoutSec + 3) * 1000);
    const statusCode = parseInt(result.stdout.slice(0, 3), 10) || 0;
    const respBody = result.stdout.slice(3).trim();
    return { ok: statusCode >= 200 && statusCode < 400, statusCode, body: respBody, latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, statusCode: 0, body: String(e?.message || e).slice(0, 200), latencyMs: Date.now() - t0 };
  }
}

/**
 * Run a command on a remote server, streaming stdout/stderr line by line as
 * it arrives. Resolves when the process exits 0, rejects on non-zero exit.
 */
export async function remoteSpawn(
  serverId: string,
  cmd: string,
  onLine: (line: string) => void,
  timeoutMs = 600000
): Promise<void> {
  const server = await loadServer(serverId);
  const ssh = await connect(server);

  let outBuf = "";
  let errBuf = "";
  const flush = (isErr: boolean, chunk: string) => {
    if (isErr) errBuf += chunk;
    else outBuf += chunk;
    let buf = isErr ? errBuf : outBuf;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    if (isErr) errBuf = buf;
    else outBuf = buf;
    for (const l of lines) onLine(l);
  };

  try {
    const result = await Promise.race([
      ssh.execCommand(cmd, {
        onStdout: (chunk: Buffer) => flush(false, chunk.toString()),
        onStderr: (chunk: Buffer) => flush(true, chunk.toString()),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      ),
    ]);
    if (outBuf) onLine(outBuf);
    if (errBuf) onLine(errBuf);
    const code = result.code ?? 0;
    if (code !== 0) throw new Error(`Command exited with code ${code}`);
  } finally {
    ssh.dispose();
  }
}
