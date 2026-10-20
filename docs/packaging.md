# Packaging: one AppImage, three products

The Linux artifact is a single file that is the GUI browser, the MCP server, and the CLI. That is
not a packaging trick for its own sake — it is what makes "an agent controls the browser" a
one-line install for the user.

```
ZimReaper-0.1.0-x86_64.AppImage                     GUI browser + control server
ZimReaper-0.1.0-x86_64.AppImage mcp                 MCP stdio server (what an agent spawns)
ZimReaper-0.1.0-x86_64.AppImage replay trace.jsonl  replay a recorded run
ZimReaper-0.1.0-x86_64.AppImage run "<task>"        autonomous loop
```

## Why the CLI works without Node installed

Electron embeds a Node runtime. `AppRun` dispatches on the first argument: for a known CLI
subcommand it sets `ELECTRON_RUN_AS_NODE=1` and executes
`resources/app/node_modules/@zimreaper/cli/dist/bin.js` with the same binary, so stdout carries
MCP JSON-RPC and no window is created. Anything else launches the GUI.

```
AppImage --help            -> CLI help, no window
AppImage                   -> GUI window
```

## Wiring an agent

Claude Desktop / Claude Code (`claude_desktop_config.json` or `claude mcp add`):

```json
{
  "mcpServers": {
    "zimreaper": {
      "command": "/home/you/Applications/ZimReaper-0.1.0-x86_64.AppImage",
      "args": ["mcp"]
    }
  }
}
```

Hermes:

```bash
hermes mcp add zimreaper --command /home/you/Applications/ZimReaper-0.1.0-x86_64.AppImage --args mcp
```

Two topologies, both verified:

| Topology | How | Use when |
|---|---|---|
| attach | User opens the AppImage; agent runs `AppImage mcp`, which reads `~/.zimreaper/endpoint.json` + `control.token` | The user wants to watch and take over |
| launch | Agent runs `AppImage mcp --launch`; the AppImage starts its own browser and control server | Unattended automation, no user present |

In attach mode the agent drives the exact window the user is looking at. The HUD shows every
action, and the kill switch and "take over" button stop it instantly.

## Serve mode (no desktop session)

```bash
ZIMREAPER_SERVE=1 ZIMREAPER_HOME=~/.zimreaper ./ZimReaper-0.1.0-x86_64.AppImage
# desktop-ready 38961
# serve-mode ws://127.0.0.1:38961
```

Keeps a live session with no visible window for agents on a headless host, then attach as usual.

**The non-obvious constraint:** an unmapped Electron window never acknowledges
`Input.dispatchMouseEvent`, so every agent click hangs until it times out. Serve mode therefore
keeps the window *mapped but invisible* (`opacity 0`, `skipTaskbar`, `ignoreMouseEvents`,
`showInactive`). `backgroundThrottling: false` is set on the shell and on every tab view for the
same reason: agents act on tabs the user is not looking at.

## Sandbox and FUSE

An AppImage cannot carry a SUID binary, so the setuid sandbox is unavailable. `AppRun` passes
`--disable-setuid-sandbox` and keeps the namespace sandbox. On kernels without unprivileged user
namespaces (some hardened distros, some container hosts):

```bash
ZIMREAPER_NO_SANDBOX=1 ./ZimReaper-0.1.0-x86_64.AppImage
```

On systems without FUSE: `./ZimReaper-0.1.0-x86_64.AppImage --appimage-extract-and-run`.

## Build

```bash
npm run build
npm run package:linux        # -> dist/ZimReaper-0.1.0-x86_64.AppImage (~97 MB)
npm run check:appimage       # 4 checks: CLI, MCP launch, serve mode, MCP attach
```

The runtime `node_modules` inside the image is assembled by walking the production dependency
closure, not by copying the dev tree. Two traps that walk had to handle, both of which produce an
image that builds fine and dies on first use:

- `@modelcontextprotocol/sdk` requires `zod-to-json-schema` at runtime but only declares some of
  its dependencies as peers — a dependencies-only walk misses them.
- `require.resolve("pkg/package.json")` can land on a nested stub (the SDK ships
  `dist/cjs/package.json` containing only `{"type":"commonjs"}`), so the resolver ascends until a
  manifest actually names the package.

## Verification

`npm run check:appimage` asserts, against the built file:

1. `AppImage --help` prints the CLI surface using the bundled Node
2. `AppImage mcp --launch` exposes 21 tools and completes a login through MCP only
3. serve mode comes up and publishes `serve-mode ws://…`
4. an MCP client attaching to that running instance completes the same login

Not done yet: code signing, auto-update, macOS `.dmg` and Windows builds (the packaging script is
Linux-only today), and an app-store-quality icon set.
