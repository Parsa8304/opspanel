import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Run a command in host namespaces via nsenter (requires pid:host + privileged)
export async function hostExec(cmd: string, timeout = 15000): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`nsenter -t 1 -m -u -i -n -p -- sh -c ${JSON.stringify(cmd)}`, { timeout });
}

// HTTP probe using the host's curl (nsenter -m -n enters host mount+network ns)
export async function hostFetch(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  timeoutSec = 8
): Promise<{ ok: boolean; statusCode: number; body: string; latencyMs: number }> {
  const t0 = Date.now();
  const bodyArgs = body
    ? `-H 'Content-Type: application/json' -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`
    : "";
  // Run everything inside a single sh -c so curl and cat share the same host namespace /tmp
  const inner = `curl -s -o /tmp/_hf_body -w '%{http_code}' --max-time ${timeoutSec} -X ${method} ${bodyArgs} '${url}' && cat /tmp/_hf_body`;
  const cmd = `nsenter -t 1 -m -n -- sh -c ${JSON.stringify(inner)}`;
  try {
    const { stdout } = await execAsync(cmd, { timeout: (timeoutSec + 3) * 1000 });
    // stdout = "<status_code><body>" — status code is printed by -w, body by cat
    const statusCode = parseInt(stdout.slice(0, 3), 10) || 0;
    const respBody = stdout.slice(3).trim();
    return { ok: statusCode >= 200 && statusCode < 400, statusCode, body: respBody, latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, statusCode: 0, body: String(e?.stderr || e?.message || e).slice(0, 200), latencyMs: Date.now() - t0 };
  }
}

// Read a host file (avoids shell quoting issues for simple paths)
export async function hostReadFile(path: string): Promise<string> {
  const { stdout } = await hostExec(`cat ${JSON.stringify(path)}`);
  return stdout;
}

// Write a host file
export async function hostWriteFile(path: string, content: string): Promise<void> {
  const escaped = content.replace(/'/g, "'\\''");
  await hostExec(`printf '%s' '${escaped}' > ${JSON.stringify(path)}`);
}

// Helper: parse key=value or key value style config lines
export function parseConfigLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (match) result[match[1]] = match[2].trim();
  }
  return result;
}
