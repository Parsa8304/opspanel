import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Run a command in host namespaces via nsenter (requires pid:host + privileged)
export async function hostExec(cmd: string, timeout = 15000): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`nsenter -t 1 -m -u -i -n -p -- sh -c ${JSON.stringify(cmd)}`, { timeout });
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
