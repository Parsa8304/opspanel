import { getSetting } from "./api";

export const CI_SETTING_KEY = "ci";

export interface CiConfig {
  type: "junit_url" | "none";
  url?: string;
  token?: string;
}

export async function getCiConfig(): Promise<CiConfig> {
  return getSetting<CiConfig>(CI_SETTING_KEY, { type: "none" });
}

export class CiNotConfiguredError extends Error {
  constructor(msg = "No JUnit CI URL configured") {
    super(msg);
    this.name = "CiNotConfiguredError";
  }
}

/** Fetch raw JUnit XML from the configured junit_url. Honest errors only —
 *  never fabricates a result when unset or unreachable. */
export async function fetchCiJunit(cfg: CiConfig): Promise<string> {
  if (cfg.type !== "junit_url" || !cfg.url) throw new CiNotConfiguredError();
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
    });
  } catch (e) {
    throw new Error(
      `Cannot reach JUnit URL: ${e instanceof Error ? e.message : "network error"}`
    );
  }
  if (!res.ok)
    throw new Error(`JUnit URL returned HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error("JUnit URL returned an empty body");
  return text;
}
