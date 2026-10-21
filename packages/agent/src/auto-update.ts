import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ZimReaperError } from "@zimreaper/protocol";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitRunnerOptions {
  cwd: string;
  timeoutMs: number;
}

export type GitRunner = (
  args: readonly string[],
  opts: GitRunnerOptions,
) => Promise<GitCommandResult>;

export interface AutoUpdateOptions {
  /** Defaults to enabled unless ZIMREAPER_AUTO_UPDATE is 0/false/off/no. */
  enabled?: boolean;
  /** Repository root; defaults to the checkout containing this package. */
  cwd?: string;
  /** Remote to fetch; defaults to ZIMREAPER_UPDATE_REMOTE or origin. */
  remote?: string;
  /** Deadline for each git command. */
  timeoutMs?: number;
  /** Injectable command runner for tests. */
  runner?: GitRunner;
}

export interface AutoUpdateResult {
  enabled: boolean;
  skipped: boolean;
  updated: boolean;
  repository?: string;
  branch?: string;
  upstream?: string;
  before?: string;
  after?: string;
  ahead: number;
  behind: number;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function autoUpdateEnabled(): boolean {
  const value = process.env.ZIMREAPER_AUTO_UPDATE?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

function findRepositoryRoot(start: string): string | undefined {
  const root = resolve(start);
  return existsSync(join(root, ".git")) ? root : undefined;
}

function defaultRepositoryRoot(): string {
  return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

function commandFailure(err: unknown, args: readonly string[]): ZimReaperError {
  const record = isRecord(err) ? err : {};
  const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
  const stdout = typeof record.stdout === "string" ? record.stdout.trim() : "";
  const detail = stderr || stdout || (err instanceof Error ? err.message : String(err));
  return new ZimReaperError(
    "INTERNAL",
    `git ${args.join(" ")} failed: ${detail || "unknown git error"}`,
    { retryable: true },
  );
}

const defaultGitRunner: GitRunner = async (args, { cwd, timeoutMs }) => {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (err) {
    throw commandFailure(err, args);
  }
};

function parseAheadBehind(stdout: string): { ahead: number; behind: number } {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(stdout.trim());
  if (!match) {
    throw new ZimReaperError("INTERNAL", `unexpected git ahead/behind output: ${stdout.trim()}`);
  }
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

function skippedResult(repository: string, message: string): AutoUpdateResult {
  return {
    enabled: true,
    skipped: true,
    updated: false,
    repository,
    ahead: 0,
    behind: 0,
    message,
  };
}

/**
 * Fast-forwards the checkout when it is strictly behind its upstream branch.
 *
 * The check is fail-closed: fetch, dirty-tree, detached-HEAD, and divergence errors abort the
 * run instead of letting an agent operate on stale code. A non-git checkout is skipped so a
 * packaged build still works.
 */
export async function ensureRepoUpdated(opts: AutoUpdateOptions = {}): Promise<AutoUpdateResult> {
  const enabled = opts.enabled ?? autoUpdateEnabled();
  if (!enabled) {
    return {
      enabled: false,
      skipped: true,
      updated: false,
      ahead: 0,
      behind: 0,
      message: "auto-update disabled",
    };
  }

  const start = resolve(opts.cwd ?? defaultRepositoryRoot());
  const repository = findRepositoryRoot(start);
  if (!repository) {
    return skippedResult(start, "not a git checkout; auto-update skipped");
  }

  const remote = opts.remote ?? process.env.ZIMREAPER_UPDATE_REMOTE ?? "origin";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = opts.runner ?? defaultGitRunner;
  const git = async (args: readonly string[]): Promise<GitCommandResult> => {
    try {
      return await runner(args, { cwd: repository, timeoutMs });
    } catch (err) {
      if (err instanceof ZimReaperError) throw err;
      throw commandFailure(err, args);
    }
  };

  const status = await git(["status", "--porcelain=v1", "--untracked-files=no"]);
  if (status.stdout.trim().length > 0) {
    throw new ZimReaperError(
      "INTERNAL",
      `working tree has uncommitted tracked changes in ${repository}; commit or stash them before running`,
    );
  }

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  if (branch.length === 0 || branch === "HEAD") {
    throw new ZimReaperError(
      "INTERNAL",
      `checkout at ${repository} is detached; switch to a branch before running`,
    );
  }

  let upstream: string;
  try {
    upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).stdout.trim();
  } catch (err) {
    throw new ZimReaperError(
      "INTERNAL",
      `branch ${branch} has no upstream; set one with git branch --set-upstream-to before running`,
      { details: ZimReaperError.from(err).message },
    );
  }

  const before = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["fetch", "--quiet", "--prune", remote]);
  const { ahead, behind } = parseAheadBehind(
    (await git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).stdout,
  );

  if (ahead > 0 && behind > 0) {
    throw new ZimReaperError(
      "INTERNAL",
      `branch ${branch} has diverged from ${upstream} (${ahead} ahead, ${behind} behind); refusing to auto-update`,
    );
  }

  if (behind === 0) {
    return {
      enabled: true,
      skipped: false,
      updated: false,
      repository,
      branch,
      upstream,
      before,
      after: before,
      ahead,
      behind,
      message:
        ahead > 0
          ? `${branch} is ${ahead} commit(s) ahead of ${upstream}; no update needed`
          : `${branch} is up to date with ${upstream}`,
    };
  }

  await git(["merge", "--ff-only", "--quiet", upstream]);
  const after = (await git(["rev-parse", "HEAD"])).stdout.trim();
  return {
    enabled: true,
    skipped: false,
    updated: true,
    repository,
    branch,
    upstream,
    before,
    after,
    ahead: 0,
    behind,
    message: `fast-forwarded ${branch} ${behind} commit(s) to ${after.slice(0, 12)}; restart to load new code`,
  };
}
