#!/usr/bin/env node
/**
 * Build a Linux AppImage that is simultaneously the GUI browser and the agent CLI.
 *
 *   ./ZimReaper-0.1.0-x86_64.AppImage              GUI browser + control server
 *   ./ZimReaper-0.1.0-x86_64.AppImage mcp          MCP stdio server (Claude / Hermes spawn this)
 *   ./ZimReaper-0.1.0-x86_64.AppImage replay t.jsonl
 *
 * Electron ships a Node runtime; with ELECTRON_RUN_AS_NODE=1 the same binary runs our CLI. That is
 * what makes one artifact serve both halves — an MCP client never needs node installed.
 *
 * The runtime node_modules is assembled explicitly (ws + zod + our workspace packages) instead of
 * copying the dev tree, so the image stays small and the dependency surface is auditable.
 *
 * Usage: node scripts/package-linux.mjs [--out dist] [--keep]
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ROOT_MANIFEST = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const VERSION = ROOT_MANIFEST.version ?? "0.1.0";
const AUTHOR = ROOT_MANIFEST.author ?? "Mr-Destroyer (zim)";
const OUT = path.join(ROOT, "dist");
const BUILD = path.join(ROOT, "build", "appimage");
const APPDIR = path.join(BUILD, "ZimReaper.AppDir");
const APP = path.join(APPDIR, "usr", "lib", "zimreaper");
const RES = path.join(APP, "resources", "app");

const WORKSPACE = ["protocol", "policy", "perception", "core", "replay", "agent", "mcp-server", "cli"];

function step(message) {
  process.stdout.write(`  ${message}\n`);
}

async function requireBuilt() {
  const missing = [];
  if (!existsSync(path.join(ROOT, "apps/desktop/dist/main.js"))) missing.push("apps/desktop (npm run build -w @zimreaper/desktop)");
  for (const pkg of WORKSPACE) {
    if (!existsSync(path.join(ROOT, "packages", pkg, "dist/index.js"))) missing.push(`packages/${pkg}`);
  }
  if (missing.length) {
    throw new Error(`build first: ${missing.join(", ")}`);
  }
}

async function stageElectron() {
  const electronDist = path.join(ROOT, "node_modules", "electron", "dist");
  if (!existsSync(path.join(electronDist, "electron"))) {
    throw new Error("node_modules/electron/dist is empty — run `npm rebuild electron` or unzip the cached release");
  }
  await cp(electronDist, APP, { recursive: true });
  // One binary, two personalities: the name is what users see in ps and on the desktop.
  await cp(path.join(APP, "electron"), path.join(APP, "zimreaper"));
  await rm(path.join(APP, "electron"), { force: true });
}

/**
 * Walk the production dependency closure from the workspace packages and return name -> realpath.
 * Hand-listing runtime deps is how packages ship broken; the walk is what keeps the image honest.
 */
function stageRuntimeDeps() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const resolved = new Map();

  // `pkg/package.json` can resolve to a nested stub (the MCP SDK ships dist/cjs/package.json
  // with only {"type":"commonjs"}), which makes a naive walk miss every real dependency.
  // Ascend until the manifest actually names the package.
  const locate = (name, fromDir) => {
    let entry;
    try {
      entry = require.resolve(`${name}/package.json`, { paths: [fromDir] });
    } catch {
      entry = require.resolve(name, { paths: [fromDir] });
    }
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir)) {
      const manifestPath = path.join(dir, "package.json");
      if (existsSync(manifestPath)) {
        try {
          if (JSON.parse(readFileSync(manifestPath, "utf8")).name) return dir;
        } catch {
          /* keep ascending */
        }
      }
      dir = path.dirname(dir);
    }
    return path.dirname(entry);
  };

  const visit = (name, fromDir) => {
    if (name.startsWith("@zimreaper/") || resolved.has(name)) return;
    let dir;
    try {
      dir = locate(name, fromDir);
    } catch {
      return; // optional or unmet peer: nothing to ship
    }
    resolved.set(name, dir);
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    // The MCP SDK requires zod-to-json-schema at runtime but only declares it as a peer, so a
    // dependencies-only walk produces an image that dies on first tool call. Walk peers too.
    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const dep of Object.keys(deps)) visit(dep, dir);
  };

  for (const pkg of WORKSPACE) {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "packages", pkg, "package.json"), "utf8"));
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      visit(dep, path.join(ROOT, "packages", pkg));
    }
  }
  return resolved;
}

async function stageApp() {
  await mkdir(RES, { recursive: true });
  await writeFile(
    path.join(RES, "package.json"),
    `${JSON.stringify(
      {
        name: "zimreaper",
        productName: "ZimReaper",
        version: VERSION,
        description: "Agentic browser: an AI agent drives a real Chromium with real input events",
        type: "module",
        main: "dist/main.js",
        author: AUTHOR,
        license: ROOT_MANIFEST.license ?? "MIT",
      },
      null,
      2,
    )}\n`,
  );

  await cp(path.join(ROOT, "apps/desktop/dist"), path.join(RES, "dist"), { recursive: true });
  // dist/ carries tsc build info and stray declaration maps; keep the image lean.
  await rm(path.join(RES, "dist", ".tsbuildinfo"), { force: true }).catch(() => undefined);

  const modules = path.join(RES, "node_modules");
  await mkdir(path.join(modules, "@zimreaper"), { recursive: true });
  for (const pkg of WORKSPACE) {
    const target = path.join(modules, "@zimreaper", pkg);
    await mkdir(target, { recursive: true });
    await cp(path.join(ROOT, "packages", pkg, "dist"), path.join(target, "dist"), { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(ROOT, "packages", pkg, "package.json"), "utf8"));
    // Trim to what resolution needs: no scripts, no dev deps, no workspace wildcards.
    await writeFile(
      path.join(target, "package.json"),
      `${JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          type: "module",
          main: manifest.main,
          types: manifest.types,
          exports: manifest.exports,
        },
        null,
        2,
      )}\n`,
    );
  }
  const runtime = stageRuntimeDeps();
  for (const [name, dir] of runtime) {
    const target = path.join(modules, name);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(dir, target, {
      recursive: true,
      filter: (src) => !src.includes("/.bin/") && !src.endsWith(".md") && !src.endsWith(".map"),
    });
  }
  step(`staged app (${WORKSPACE.length} packages + ${runtime.size} runtime deps)`);
}

async function stageLauncher() {
  const appRun = `#!/bin/sh
# ZimReaper AppRun: one artifact, two personalities.
set -e
HERE=$(dirname "$(readlink -f "$0")")
BIN="$HERE/usr/lib/zimreaper/zimreaper"
CLI="$HERE/usr/lib/zimreaper/resources/app/node_modules/@zimreaper/cli/dist/bin.js"

case "\${1:-}" in
  mcp|run|attach|info|audit|replay|--help|-h|--version)
    # Agent path: Electron as a plain Node runtime, no window, stdout speaks MCP.
    export ELECTRON_RUN_AS_NODE=1
    exec "$BIN" "$CLI" "$@"
    ;;
esac

# GUI path. AppImages cannot carry SUID, so the setuid sandbox is unavailable; the namespace
# sandbox still applies. Set ZIMREAPER_NO_SANDBOX=1 only on kernels without unprivileged userns.
FLAGS="--disable-setuid-sandbox"
if [ "\${ZIMREAPER_NO_SANDBOX:-0}" = "1" ]; then
  FLAGS="--no-sandbox"
fi
exec "$BIN" $FLAGS "$@"
`;
  await writeFile(path.join(APPDIR, "AppRun"), appRun, { mode: 0o755 });

  await writeFile(
    path.join(APPDIR, "zimreaper.desktop"),
    `[Desktop Entry]
Type=Application
Name=ZimReaper
Comment=Agentic browser — let an AI agent drive a real browser
Exec=zimreaper %U
Icon=zimreaper
Terminal=false
Categories=Network;WebBrowser;Development;
MimeType=x-scheme-handler/http;x-scheme-handler/https;
StartupWMClass=ZimReaper
`,
  );
  await cp(path.join(APPDIR, "zimreaper.desktop"), path.join(APPDIR, "usr/share/applications/zimreaper.desktop"));
  step("staged AppRun + desktop entry");
}

async function stageIcon() {
  const iconDir = path.join(APPDIR, "usr/share/icons/hicolor/256x256/apps");
  await mkdir(iconDir, { recursive: true });
  const script = path.join(BUILD, "icon.py");
  await writeFile(
    script,
    `from PIL import Image, ImageDraw
size = 256
img = Image.new("RGBA", (size, size), (10, 12, 14, 255))
d = ImageDraw.Draw(img)
d.rounded_rectangle([8, 8, size - 8, size - 8], radius=44, outline=(34, 197, 94, 255), width=10)
# A reaper's blade over a browser window: arc + crossbar + window chrome.
d.arc([52, 40, 204, 192], start=200, end=340, fill=(34, 197, 94, 255), width=16)
d.line([128, 96, 128, 208], fill=(34, 197, 94, 255), width=12)
d.line([96, 132, 160, 132], fill=(34, 197, 94, 255), width=10)
d.rectangle([84, 176, 172, 214], outline=(148, 163, 184, 255), width=6)
img.save(${JSON.stringify(path.join(iconDir, "zimreaper.png"))})
`,
  );
  execFileSync("python3", [script], { stdio: "inherit" });
  await cp(path.join(iconDir, "zimreaper.png"), path.join(APPDIR, "zimreaper.png"));
  await cp(path.join(iconDir, "zimreaper.png"), path.join(APPDIR, ".DirIcon"));
  step("staged icon");
}

async function makeAppImage() {
  await mkdir(OUT, { recursive: true });
  const target = path.join(OUT, `ZimReaper-${VERSION}-x86_64.AppImage`);
  await rm(target, { force: true });
  const tool = existsSync(path.join(process.env.HOME ?? "", ".local/bin/appimagetool"))
    ? path.join(process.env.HOME ?? "", ".local/bin/appimagetool")
    : "appimagetool";
  const args = [APPDIR, target, "--no-appstream"];
  try {
    execFileSync(tool, args, { stdio: "inherit", env: { ...process.env, ARCH: "x86_64" } });
  } catch (err) {
    // appimagetool is itself an AppImage; without FUSE it needs the extract-and-run shim.
    process.stdout.write("  retrying appimagetool via --appimage-extract-and-run\n");
    execFileSync(tool, ["--appimage-extract-and-run", ...args], {
      stdio: "inherit",
      env: { ...process.env, ARCH: "x86_64", APPIMAGE_EXTRACT_AND_RUN: "1" },
    });
  }
  execFileSync("chmod", ["+x", target]);
  const size = (await readFile(target)).length;
  return { target, mb: (size / 1024 / 1024).toFixed(1) };
}

process.stdout.write(`packaging ZimReaper ${VERSION}\n`);
await requireBuilt();
await rm(BUILD, { recursive: true, force: true });
await mkdir(APP, { recursive: true });
await stageElectron();
step("staged electron runtime");
await stageApp();
await stageLauncher();
await stageIcon();
const { target, mb } = await makeAppImage();
process.stdout.write(`\n${target} (${mb} MB)\n`);
if (!process.argv.includes("--keep")) await rm(BUILD, { recursive: true, force: true });
