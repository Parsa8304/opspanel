import { exec, spawn } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Run a command in host namespaces via nsenter (requires pid:host + privileged)
export async function hostExec(cmd: string, timeout = 15000): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`nsenter -t 1 -m -u -i -n -p -- sh -c ${JSON.stringify(cmd)}`, { timeout });
}

/**
 * Spawn a command in host namespaces and stream stdout+stderr line by line.
 * onLine is called for each line as it arrives (unbuffered).
 * Resolves when the process exits 0, rejects on non-zero exit.
 */
export function hostSpawn(
  cmd: string,
  onLine: (line: string) => void,
  timeoutMs = 600000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("nsenter", ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-c", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buf = "";
    const flush = (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    };

    child.stdout.on("data", (d: Buffer) => flush(d.toString()));
    child.stderr.on("data", (d: Buffer) => flush(d.toString()));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf) onLine(buf); // flush remaining partial line
      if (code === 0) resolve();
      else reject(new Error(`Command exited with code ${code}`));
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// HTTP probe using the host's curl (nsenter -m -n enters host mount+network ns)
export async function hostFetch(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  timeoutSec = 8
): Promise<{ ok: boolean; statusCode: number; body: string; latencyMs: number }> {
  const t0 = Date.now();
  // Write JSON body to a temp file to avoid all shell quoting issues with special chars
  const bodyArgs = body
    ? `-H 'Content-Type: application/json' -d @/tmp/_hf_req`
    : "";
  const writeBody = body
    ? `printf '%s' ${JSON.stringify(JSON.stringify(body))} > /tmp/_hf_req && `
    : "";
  // Single sh -c keeps curl + cat in the same host namespace so /tmp/_hf_body is accessible
  const inner = `${writeBody}curl -s -o /tmp/_hf_body -w '%{http_code}' --max-time ${timeoutSec} -X ${method} ${bodyArgs} ${JSON.stringify(url)} && cat /tmp/_hf_body`;
  const cmd = `nsenter -t 1 -m -n -- sh -c ${JSON.stringify(inner)}`;
  try {
    const { stdout } = await execAsync(cmd, { timeout: (timeoutSec + 3) * 1000 });
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

// ─── sshd_config change validation ──────────────────────────────────────────
// These values are interpolated into shell commands run as root via nsenter/SSH.
// A directive key must be a bare alphanumeric token; a value may only contain a
// conservative charset with NO shell metacharacters, whitespace-splitting, or
// newlines (which would let an attacker append arbitrary sshd directives or
// break out of the sed/echo command). Reject anything else outright.
const SSHD_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SSHD_VALUE_RE = /^[A-Za-z0-9 _.,:@/=+-]{1,256}$/;

export class SshdConfigError extends Error {}

/** Validate a changes map of sshd_config directives. Throws SshdConfigError. */
export function validateSshdChanges(
  changes: Record<string, string>
): Array<[string, string]> {
  if (!changes || typeof changes !== "object")
    throw new SshdConfigError("changes must be an object");
  const out: Array<[string, string]> = [];
  for (const [key, rawValue] of Object.entries(changes)) {
    const value = String(rawValue);
    if (!SSHD_KEY_RE.test(key))
      throw new SshdConfigError(`Invalid sshd directive name: ${JSON.stringify(key)}`);
    if (!SSHD_VALUE_RE.test(value))
      throw new SshdConfigError(
        `Invalid value for ${key}: contains disallowed characters`
      );
    out.push([key, value]);
  }
  return out;
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
