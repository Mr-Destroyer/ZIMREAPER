import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZimReaperError } from "@zimreaper/protocol";
import { createFileVault } from "../src/index.js";
import { tempDir } from "./helpers.js";

describe("file vault", () => {
  it("round-trips values and lists names only", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const vault = createFileVault(dir);
      expect(await vault.list()).toEqual([]);

      await vault.set("alpha", "s3cret");
      await vault.set("beta", "other");

      expect(await vault.get("alpha")).toBe("s3cret");
      expect(await vault.get("missing")).toBeUndefined();
      expect(await vault.list()).toEqual(["alpha", "beta"]);
      expect(await vault.remove("alpha")).toBe(true);
      expect(await vault.remove("alpha")).toBe(false);
      expect(await vault.get("alpha")).toBeUndefined();
      expect(await vault.list()).toEqual(["beta"]);
    } finally {
      cleanup();
    }
  });

  it("persists across vault instances", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const vault = createFileVault(dir);
      await vault.set("alpha", "persisted");
      const reopened = createFileVault(dir);
      expect(await reopened.get("alpha")).toBe("persisted");
    } finally {
      cleanup();
    }
  });

  it("encrypts values at rest and keeps the keyfile private", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const vault = createFileVault(dir);
      await vault.set("alpha", "plaintext-should-not-appear");

      const vaultRaw = readFileSync(join(dir, "vault.json"), "utf8");
      const keyRaw = readFileSync(join(dir, "vault.key"), "utf8");
      expect(vaultRaw).not.toContain("plaintext-should-not-appear");
      expect(keyRaw).not.toContain("plaintext-should-not-appear");
      expect(statSync(join(dir, "vault.key")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "vault.json")).mode & 0o777).toBe(0o600);
      expect(await vault.list()).toEqual(["alpha"]);
    } finally {
      cleanup();
    }
  });

  it("rejects tampered ciphertext", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const vault = createFileVault(dir);
      await vault.set("alpha", "s3cret");
      const path = join(dir, "vault.json");
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        entries: Record<string, { data: string }>;
      };
      const data = parsed.entries.alpha.data;
      parsed.entries.alpha.data = `${data[0] === "A" ? "B" : "A"}${data.slice(1)}`;
      writeFileSync(path, JSON.stringify(parsed));

      await expect(vault.get("alpha")).rejects.toBeInstanceOf(ZimReaperError);
    } finally {
      cleanup();
    }
  });

  it("rejects an empty entry name", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const vault = createFileVault(dir);
      await expect(vault.set("", "value")).rejects.toBeInstanceOf(ZimReaperError);
    } finally {
      cleanup();
    }
  });

  it("handles unicode and large values", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const vault = createFileVault(dir);
      const value = "line one\nline two 😀\u0000end".repeat(500);
      await vault.set("blob", value);
      expect(await vault.get("blob")).toBe(value);
    } finally {
      cleanup();
    }
  });
});
