import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

/**
 * These assertions are about build output, so they only mean something if the build ran. On a
 * clean checkout (CI, fresh clone) `dist/` does not exist — it is gitignored — and asserting on
 * missing files tests the filesystem, not the build. Build once here instead of making the whole
 * suite depend on someone having run `npm run build` first.
 */
beforeAll(() => {
  if (existsSync(resolve(appRoot, "dist/preload.cjs"))) return;
  execFileSync("npm", ["run", "build"], { cwd: appRoot, stdio: "ignore" });
}, 180_000);

describe("desktop artifacts and config", () => {
  it("declares an ESM Electron entry and build scripts", () => {
    const pkg = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")) as {
      type?: string;
      main?: string;
      scripts?: Record<string, string>;
    };
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("./dist/main.js");
    expect(pkg.scripts?.build).toContain("build-preload.mjs");
    expect(pkg.scripts?.build).toContain("vite build");
  });

  it("builds a preload bundle and renderer entry", () => {
    expect(existsSync(resolve(appRoot, "dist/preload.cjs"))).toBe(true);
    expect(existsSync(resolve(appRoot, "dist/renderer/index.html"))).toBe(true);
    expect(existsSync(resolve(appRoot, "dist/main.js"))).toBe(true);
  });

  it("keeps preload isolated from Node in the window", () => {
    const source = readFileSync(resolve(appRoot, "src/main/window-shell.ts"), "utf8");
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("preload.cjs");
  });
});
