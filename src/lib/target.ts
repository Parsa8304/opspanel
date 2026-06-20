import { hostExec, hostSpawn, hostFetch } from "./server";
import { remoteExec, remoteSpawn, remoteFetch } from "./remote";

/**
 * Unified exec surface for "the machine behind a server tab" — either the
 * local host (serverId === "local", via nsenter) or a registered RemoteServer
 * (via SSH). Every server-scoped API route should go through this instead of
 * calling hostExec/hostSpawn/hostFetch or remoteExec/remoteSpawn directly, so
 * a single id-shaped param decides local vs remote.
 */

export const LOCAL_ID = "local";

export async function targetExec(
  serverId: string,
  cmd: string,
  timeout = 15000
): Promise<{ stdout: string; stderr: string; code?: number }> {
  if (serverId === LOCAL_ID) return hostExec(cmd, timeout);
  return remoteExec(serverId, cmd, timeout);
}

export function targetSpawn(
  serverId: string,
  cmd: string,
  onLine: (line: string) => void,
  timeoutMs = 600000
): Promise<void> {
  if (serverId === LOCAL_ID) return hostSpawn(cmd, onLine, timeoutMs);
  return remoteSpawn(serverId, cmd, onLine, timeoutMs);
}

export async function targetFetch(
  serverId: string,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  timeoutSec = 8
): Promise<{ ok: boolean; statusCode: number; body: string; latencyMs: number }> {
  if (serverId === LOCAL_ID) return hostFetch(method, url, body, timeoutSec);
  return remoteFetch(serverId, method, url, body, timeoutSec);
}

export async function targetReadFile(serverId: string, path: string): Promise<string> {
  const { stdout } = await targetExec(serverId, `cat ${JSON.stringify(path)}`);
  return stdout;
}

export async function targetWriteFile(serverId: string, path: string, content: string): Promise<void> {
  const escaped = content.replace(/'/g, "'\\''");
  await targetExec(serverId, `printf '%s' '${escaped}' > ${JSON.stringify(path)}`);
}
