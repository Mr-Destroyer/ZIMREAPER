import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureRepoUpdated, type GitCommandResult, type GitRunner } from "../src/index.js";

interface FakeGitOptions {
  dirty?: boolean;
  branch?: string;
  upstream?: string;
  noUpstream?: boolean;
  ahead?: number;
  behind?: number;
  after?: string;
}

function fakeGit(opts: FakeGitOptions = {}): { runner: GitRunner; commands: string[][] } {
  const commands: string[][] = [];
  const branch = opts.branch ?? "main";
  const upstream = opts.upstream ?? "origin/main";
  const ahead = opts.ahead ?? 0;
  const behind = opts.behind ?? 0;
  const before = "1111111111111111111111111111111111111111";
  const after = opts.after ?? "2222222222222222222222222222222222222222";

  const runner: GitRunner = async (args): Promise<GitCommandResult> => {
    commands.push([...args]);
    const command = args.join(" ");
    if (command === "status --porcelain=v1 --untracked-files=no") {
      return { stdout: opts.dirty ? " M packages/agent/src/index.ts\n" : "", stderr: "" };
    }
    if (command === "rev-parse --abbrev-ref HEAD") return { stdout: `${branch}\n`, stderr: "" };
    if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
      if (opts.noUpstream) throw new Error("fatal: no upstream configured");
      return { stdout: `${upstream}\n`, stderr: "" };
    }
    if (command === "rev-parse HEAD") {
      const merged = commands.some((item) => item[0] === "merge");
      return { stdout: `${merged ? after : before}\n`, stderr: "" };
    }
    if (command === "fetch --quiet --prune origin") return { stdout: "", stderr: "" };
    if (command === `rev-list --left-right --count HEAD...${upstream}`) {
      return { stdout: `${ahead}\t${behind}\n`, stderr: "" };
    }
    if (command === `merge --ff-only --quiet ${upstream}`) return { stdout: "", stderr: "" };
    throw new Error(`unexpected git command: ${command}`);
  };

  return { runner, commands };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zim-update-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "nested"));
  return root;
}

describe("ensureRepoUpdated", () => {
  it("fast-forwards a checkout that is strictly behind", async () => {
    const cwd = await repository();
    const { runner, commands } = fakeGit({ behind: 2 });
    const result = await ensureRepoUpdated({ cwd, runner });

    expect(result).toMatchObject({
      enabled: true,
      skipped: false,
      updated: true,
      branch: "main",
      upstream: "origin/main",
      behind: 2,
    });
    expect(result.after).toBe("2222222222222222222222222222222222222222");
    expect(commands.map((args) => args.join(" "))).toContain("merge --ff-only --quiet origin/main");
  });

  it("does not merge when already up to date", async () => {
    const cwd = await repository();
    const { runner, commands } = fakeGit();
    const result = await ensureRepoUpdated({ cwd, runner });

    expect(result).toMatchObject({ updated: false, behind: 0, ahead: 0 });
    expect(commands.some((args) => args[0] === "merge")).toBe(false);
  });

  it("allows a local-ahead branch without touching it", async () => {
    const cwd = await repository();
    const { runner, commands } = fakeGit({ ahead: 3 });
    const result = await ensureRepoUpdated({ cwd, runner });

    expect(result).toMatchObject({ updated: false, ahead: 3, behind: 0 });
    expect(result.message).toContain("ahead");
    expect(commands.some((args) => args[0] === "merge")).toBe(false);
  });

  it("refuses to run with uncommitted tracked changes", async () => {
    const cwd = await repository();
    const { runner, commands } = fakeGit({ dirty: true });
    await expect(ensureRepoUpdated({ cwd, runner })).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining("uncommitted tracked changes"),
    });
    expect(commands.some((args) => args[0] === "fetch")).toBe(false);
  });

  it("refuses a diverged branch instead of creating a merge", async () => {
    const cwd = await repository();
    const { runner, commands } = fakeGit({ ahead: 1, behind: 2 });
    await expect(ensureRepoUpdated({ cwd, runner })).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining("diverged"),
    });
    expect(commands.some((args) => args[0] === "merge")).toBe(false);
  });

  it("reports a branch without an upstream", async () => {
    const cwd = await repository();
    const { runner } = fakeGit({ noUpstream: true });
    await expect(ensureRepoUpdated({ cwd, runner })).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining("has no upstream"),
    });
  });

  it("is a no-op when disabled", async () => {
    const { runner, commands } = fakeGit();
    const result = await ensureRepoUpdated({ enabled: false, runner });
    expect(result).toMatchObject({ enabled: false, skipped: true, updated: false });
    expect(commands).toHaveLength(0);
  });

  it("skips a directory that is not a git checkout", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zim-no-git-"));
    const { runner, commands } = fakeGit();
    const result = await ensureRepoUpdated({ cwd, runner });
    expect(result).toMatchObject({ skipped: true, updated: false });
    expect(commands).toHaveLength(0);
  });

  it("surfaces git failures as typed errors", async () => {
    const cwd = await repository();
    const { runner } = fakeGit();
    const failingRunner: GitRunner = async (args, opts) => {
      if (args[0] === "fetch") throw new Error("network down");
      return runner(args, opts);
    };
    await expect(ensureRepoUpdated({ cwd, runner: failingRunner })).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining("network down"),
    });
  });
});
