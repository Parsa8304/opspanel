import { simpleGit, type SimpleGit } from "simple-git";
import { getSetting } from "./api";

export interface GitConfig {
  provider: "github" | "gitlab" | "gitea" | "local";
  repoPath?: string;
  repoUrl?: string;
  branch?: string;
  token?: string;
}

export const GIT_SETTING_KEY = "git";

const DEFAULT_CONFIG: GitConfig = { provider: "local" };

/** Thrown when no usable git repo is configured. Callers map this to 409. */
export class GitNotConfiguredError extends Error {
  code = "GIT_NOT_CONFIGURED" as const;
  constructor(msg = "Git repository is not configured.") {
    super(msg);
    this.name = "GitNotConfiguredError";
  }
}

export async function getGitConfig(): Promise<GitConfig> {
  return getSetting<GitConfig>(GIT_SETTING_KEY, DEFAULT_CONFIG);
}

export interface RepoHandle {
  git: SimpleGit;
  config: GitConfig;
  repoPath: string;
}

/**
 * Resolve a usable git repo from the Setting. Throws GitNotConfiguredError
 * when no local repoPath is set or the path is not a git working tree.
 * We never fabricate data — only a real on-disk clone is queried.
 */
export async function getRepo(): Promise<RepoHandle> {
  const config = await getGitConfig();
  const repoPath = config.repoPath?.trim();
  if (!repoPath) {
    throw new GitNotConfiguredError(
      "No repository path configured. Set the git Setting (repoPath) first."
    );
  }
  const git = simpleGit(repoPath);
  let isRepo = false;
  try {
    isRepo = await git.checkIsRepo();
  } catch {
    isRepo = false;
  }
  if (!isRepo) {
    throw new GitNotConfiguredError(
      `Configured repoPath is not a git repository: ${repoPath}`
    );
  }
  return { git, config, repoPath };
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  message: string;
  changedFiles: string[];
}

export async function log(opts: { maxCount?: number } = {}): Promise<CommitInfo[]> {
  const { git } = await getRepo();
  const maxCount = Math.min(Math.max(opts.maxCount ?? 50, 1), 500);
  const raw = await git.log({ maxCount });
  const out: CommitInfo[] = [];
  for (const c of raw.all) {
    let changedFiles: string[] = [];
    try {
      const stat = await git.raw([
        "show",
        "--name-only",
        "--pretty=format:",
        c.hash,
      ]);
      changedFiles = stat
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      changedFiles = [];
    }
    out.push({
      sha: c.hash,
      shortSha: c.hash.slice(0, 8),
      author: c.author_name,
      email: c.author_email,
      date: c.date,
      message: c.message,
      changedFiles,
    });
  }
  return out;
}

export interface DiffEntry {
  status: string; // A | M | D | R...
  file: string;
}
export interface DiffResult {
  a: string;
  b: string;
  files: DiffEntry[];
  summary: { files: number; insertions: number; deletions: number };
  patch: string;
}

export async function diff(shaA: string, shaB: string): Promise<DiffResult> {
  const { git } = await getRepo();
  const range = `${shaA}..${shaB}`;
  const nameStatus = await git.raw(["diff", "--name-status", range]);
  const files: DiffEntry[] = nameStatus
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/\t+/);
      return { status: parts[0], file: parts.slice(1).join(" -> ") };
    });
  const shortstat = await git.raw(["diff", "--shortstat", range]);
  const ins = /(\d+) insertion/.exec(shortstat);
  const del = /(\d+) deletion/.exec(shortstat);
  const patch = await git.raw(["diff", "--stat", range]);
  return {
    a: shaA,
    b: shaB,
    files,
    summary: {
      files: files.length,
      insertions: ins ? Number(ins[1]) : 0,
      deletions: del ? Number(del[1]) : 0,
    },
    patch: patch.trim(),
  };
}

export interface TagInfo {
  name: string;
  sha: string;
  date: string | null;
}

export async function tags(): Promise<TagInfo[]> {
  const { git } = await getRepo();
  const raw = await git.raw([
    "for-each-ref",
    "--sort=-creatordate",
    "--format=%(refname:short)\t%(objectname)\t%(creatordate:iso-strict)",
    "refs/tags",
  ]);
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, sha, date] = l.split("\t");
      return { name, sha, date: date || null };
    });
}

export async function currentHead(): Promise<{ sha: string; shortSha: string; branch: string }> {
  const { git } = await getRepo();
  const sha = (await git.revparse(["HEAD"])).trim();
  let branch = "";
  try {
    branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  } catch {
    branch = "";
  }
  return { sha, shortSha: sha.slice(0, 8), branch };
}

/** Commit subjects strictly between refA (exclusive) and refB (inclusive). */
export async function changelogBetween(
  refA: string,
  refB: string
): Promise<string[]> {
  const { git } = await getRepo();
  const raw = await git.raw([
    "log",
    "--pretty=format:%s",
    `${refA}..${refB}`,
  ]);
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}
