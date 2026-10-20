# ZIMREAPER

**An agentic browser. Your AI agent gets a real browser and real hands.**

Not a headless scraper. Not DOM `.click()`. ZIMREAPER is a full Chromium you can watch, where an
agent moves the actual cursor, presses the actual mouse buttons, types through the real keyboard
path, scrolls with a real wheel — and where every action is visible in a HUD, gated by policy, and
written to a tamper-evident audit log.

> **Author:** Mr-Destroyer (**zim**)
> **YouTube:** [study_hard69](https://www.youtube.com/@study_hard69)
> Built to be driven by agents — Claude, Hermes, Codex, or anything that speaks MCP.

---

## Contents

1. [What it actually is](#what-it-actually-is)
2. [Download and install](#download-and-install)
3. [First run](#first-run)
4. [Point your agent at it](#point-your-agent-at-it) — Claude Desktop, Claude Code, Hermes, Codex, Cursor, Cline, generic MCP, raw WebSocket
5. [Instructions to paste into your agent](#instructions-to-paste-into-your-agent)
6. [The 21 tools your agent gets](#the-21-tools-your-agent-gets)
7. [Trust, policy and the kill switch](#trust-policy-and-the-kill-switch)
8. [Headless / server mode](#headless--server-mode)
9. [Record and replay](#record-and-replay)
10. [Troubleshooting](#troubleshooting)
11. [Build from source](#build-from-source)
12. [Repo layout](#repo-layout)

---

## What it actually is

One 97 MB file, `ZimReaper-0.1.0-x86_64.AppImage`, that is three products at once:

| You run | You get |
|---|---|
| `./ZimReaper-0.1.0-x86_64.AppImage` | The browser window. Real Chromium, tabs, HUD showing every agent action. |
| `./ZimReaper-0.1.0-x86_64.AppImage mcp` | An MCP server on stdio. This is what your agent spawns. |
| `./ZimReaper-0.1.0-x86_64.AppImage replay trace.jsonl` | The CLI: replay a recorded run as a regression test. |

The agent does **not** live inside the AppImage and does not need to. The browser opens a control
server on `ws://127.0.0.1:<port>`, writes the port and a bearer token to `~/.zimreaper/`, and your
agent connects to it. You can sit and watch the cursor move, or take over mid-task.

Because Electron ships its own Node runtime, `AppImage mcp` runs the MCP server on that embedded
Node. **Your agent host does not need Node, npm, or a second download.**

```
your agent (Claude / Hermes / Codex / …)
        │  MCP over stdio
        ▼
ZimReaper AppImage  ──  control server (ws://127.0.0.1:7420, bearer token, 0600)
        │  CDP
        ▼
real Chromium window  ──  real mouse, real keyboard, real wheel
```

---

## Download and install

```bash
# 1. make it executable
chmod +x ZimReaper-0.1.0-x86_64.AppImage

# 2. put it somewhere stable
mkdir -p ~/Applications
mv ZimReaper-0.1.0-x86_64.AppImage ~/Applications/
```

That is the whole install. No dependencies, no package manager, no root.

Optional — add it to your application menu:

```bash
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/zimreaper.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=ZimReaper
Comment=Agentic browser
Exec=/home/YOU/Applications/ZimReaper-0.1.0-x86_64.AppImage %U
Icon=zimreaper
Terminal=false
Categories=Network;WebBrowser;
EOF
```

**Two environment notes for Linux:**

- *No FUSE?* (some containers, some hardened hosts) run it as
  `./ZimReaper-0.1.0-x86_64.AppImage --appimage-extract-and-run`.
- *Sandbox refused?* An AppImage cannot carry a SUID binary, so the setuid sandbox is off by
  default and the namespace sandbox stays on. On kernels that also block unprivileged user
  namespaces, run with `ZIMREAPER_NO_SANDBOX=1 ./ZimReaper-0.1.0-x86_64.AppImage`.

---

## First run

```bash
~/Applications/ZimReaper-0.1.0-x86_64.AppImage
```

A window opens. On first launch it creates:

```
~/.zimreaper/
├── endpoint.json     # {"url":"ws://127.0.0.1:7420","port":7420,...}
├── control.token     # bearer token, mode 0600
├── policy.json       # which sites the agent may touch, and how far
└── audit/            # hash-chained JSONL, one file per day
```

Check it from the outside:

```bash
~/Applications/ZimReaper-0.1.0-x86_64.AppImage info
```

Leave the window open. Everything below connects to that running window.

---

## Point your agent at it

Any MCP client works. The only thing that changes between them is the file you edit. Replace
`/home/YOU` with your actual home path.

### Claude Desktop

Edit `~/.config/Claude/claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "zimreaper": {
      "command": "/home/YOU/Applications/ZimReaper-0.1.0-x86_64.AppImage",
      "args": ["mcp"]
    }
  }
}
```

Restart Claude Desktop. The browser tools appear under the tools icon.

### Claude Code

```bash
claude mcp add zimreaper -- /home/YOU/Applications/ZimReaper-0.1.0-x86_64.AppImage mcp
claude mcp list          # should show zimreaper: connected
```

### Hermes

```bash
hermes mcp add zimreaper --command /home/YOU/Applications/ZimReaper-0.1.0-x86_64.AppImage --args mcp
hermes mcp list
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.zimreaper]
command = "/home/YOU/Applications/ZimReaper-0.1.0-x86_64.AppImage"
args = ["mcp"]
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` per project):

```json
{
  "mcpServers": {
    "zimreaper": {
      "command": "/home/YOU/Applications/ZimReaper-0.1.0-x86_64.AppImage",
      "args": ["mcp"]
    }
  }
}
```

### Cline / Continue / Windsurf / VS Code MCP

Same JSON shape as Cursor, in the extension's MCP settings file. VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "zimreaper": {
      "type": "stdio",
      "command": "/home/YOU/Applications/ZimReaper-0.1.0-x86_64.AppImage",
      "args": ["mcp"]
    }
  }
}
```

### Any other MCP client

- Transport: **stdio**
- Command: `/home/YOU/Applications/ZimReaper-0.1.0-x86_64.AppImage`
- Arguments: `mcp`
- Environment: nothing required. Optional `ZIMREAPER_HOME` if you keep state elsewhere.

### No MCP? Talk to it directly

The control plane is a plain WebSocket with a JSON-RPC-shaped protocol (`docs/protocol.md`):

```bash
# terminal 1
~/Applications/ZimReaper-0.1.0-x86_64.AppImage

# terminal 2 — port and token come from the discovery file
cat ~/.zimreaper/endpoint.json
cat ~/.zimreaper/control.token
```

Or skip MCP entirely and let the built-in agent loop drive:

```bash
export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY / ZIMREAPER_API_KEY
~/Applications/ZimReaper-0.1.0-x86_64.AppImage run "find the cheapest plan and screenshot it" \
  --url https://example.com
```

### Two ways to connect, and when to use each

| Mode | How the agent starts | What happens | Use when |
|---|---|---|---|
| **attach** (default) | `AppImage mcp` | Reads `~/.zimreaper/endpoint.json` and drives the browser **you already have open** | You want to watch, and to be able to take over |
| **launch** | `AppImage mcp --launch` | The AppImage starts its own Chromium and control server, then drives that | Unattended work, cron, CI, no human present |

To force launch mode in an MCP config, add `"--launch"` to `args`.

---

## Instructions to paste into your agent

Most agents use the tools badly at first — they click stale refs and re-read the whole page after
every step. Paste this into the system prompt / project rules:

Copy the full block (and the reasoning behind each rule) from [`docs/agent-prompt.md`](docs/agent-prompt.md):

```
You control a real browser through the zimreaper MCP tools. Rules:

1. Call browser_snapshot before acting. Refs (e2, e7, …) are valid only for the snapshot you
   just took. After any navigation, click that changes the page, or a wait that fired, take a
   fresh snapshot instead of reusing old refs.
2. Click and type by ref, never by guessed CSS. If a ref is missing, snapshot again and look for
   the element by its accessible name.
3. After an action that loads content, prefer browser_diff with the previous snapshot id over a
   full re-snapshot. It returns only what changed, which is cheaper and less error-prone.
4. Use browser_wait for async work (text, selector, network idle) instead of sleeping or
   re-snapshotting in a loop.
5. Do not use browser_eval to do what a real interaction can do. It is policy-gated and often
   refused; mouse and keyboard paths are what this browser exists for.
6. Use browser_extract for tables and lists — give it a row selector and field selectors, and it
   returns structured JSON. Do not scrape rendered text by hand.
7. If a tool returns BLOCKED_BY_POLICY, the site is not trusted yet. Tell the human which origin
   needs approval (browser_ask_human) instead of trying workarounds.
8. If two attempts at the same step fail, call browser_ask_human and hand over. Do not loop.
9. Report what you did in terms of the page: URL, page title, and the text you verified.
```

---

## The 21 tools your agent gets

**Navigate and look**

| Tool | What it does |
|---|---|
| `browser_navigate` | Go to a URL, wait for the lifecycle event, return a snapshot |
| `browser_nav` | History: `back` / `forward` / `reload` |
| `browser_snapshot` | The page as compact ref-tagged text, token-budgeted |
| `browser_diff` | Only what changed since a previous snapshot id |
| `browser_screenshot` | PNG, optionally annotated with numbered marks |
| `browser_wait` | Wait for selector, text, URL fragment, network idle, expression, or a ref to vanish |

**Act with real input**

| Tool | What it does |
|---|---|
| `browser_click` | Real mouse press/release at the element's box-model centre |
| `browser_type` | Real key events / IME insert into the focused element |
| `browser_press` | A key or chord (`Enter`, `Tab`, `Control+Shift+T`) |
| `browser_hover` | Move the real cursor and hold |
| `browser_drag` | Real drag from one target to another |
| `browser_scroll` | Real wheel event on the page or a target |
| `browser_set_viewport` | Resize, optionally emulate a mobile device |

**Superhuman — things a human browsing cannot do**

| Tool | What it does |
|---|---|
| `browser_extract` | Repeating elements → structured JSON rows, no CSS knowledge needed by the model |
| `browser_network` | `log` / `body` / `route` / `replay` — see and rewrite what the page fetches |
| `browser_cookies` | Read, set, clear cookies outside the page |
| `browser_fork_session` | Clone the live session into independent tabs that share the login |
| `browser_eval` | Evaluate JS in the page (policy-gated) |
| `browser_tabs` | List / new / close / activate |
| `browser_ask_human` | Pause and hand the browser back to the human |
| `browser_task` | Run a whole autonomous task with the built-in loop (needs a model key) |

---

## Trust, policy and the kill switch

Nothing is trusted by default. `~/.zimreaper/policy.json` decides what the agent may do per origin:

```json
{
  "mode": "standard",
  "origins": {
    "127.0.0.1":            { "tier": "transact", "allowEval": true, "allowUploads": true },
    "news.ycombinator.com": { "tier": "read" },
    "mail.google.com":      { "tier": "interact" }
  },
  "maxActionsPerMinute": 240
}
```

| Tier | The agent may |
|---|---|
| `read` | navigate, snapshot, extract, screenshot |
| `interact` | the above + click, type, scroll — the default for any origin you have not listed |
| `transact` | the above + form submits, uploads, and `eval` when `allowEval` is true |

Modes set the floor: `strict` makes unlisted origins read-only, `standard` gives them `interact`,
`permissive` gives them `transact`. Independently of tiers, actions whose label matches a
destructive pattern (`pay`, `buy now`, `place order`, `delete`, `transfer`, `authorize`, …) pause
for human approval, and the whole session is rate-limited by `maxActionsPerMinute`.

Every action is appended to `~/.zimreaper/audit/*.jsonl` in a hash chain — editing history breaks
verification:

```bash
~/Applications/ZimReaper-0.1.0-x86_64.AppImage audit verify
```

The HUD is the kill switch: stop the agent, close the tab, or take the mouse back at any moment.
The agent's next action is refused and it is told the human intervened.

---

## Headless / server mode

For a box with no desktop session, or to run the browser as a service:

```bash
ZIMREAPER_SERVE=1 ~/Applications/ZimReaper-0.1.0-x86_64.AppImage
# desktop-ready 38961
# serve-mode ws://127.0.0.1:38961
```

No visible window, same control server, same policy, same audit log. Agents attach exactly as
before.

*(Under the hood: the window is kept mapped but invisible — opacity 0, skip-taskbar, no mouse
events. An unmapped Electron window never acknowledges `Input.dispatchMouseEvent`, which makes
every agent click hang until it times out. That is a Chromium behaviour, not a ZimReaper one, and
it is why serve mode is not simply `show: false`.)*

---

## Record and replay

Every session can be recorded and re-run as a regression test.

```bash
~/Applications/ZimReaper-0.1.0-x86_64.AppImage replay login.jsonl --url https://site/login
```

Traces store each target's role, accessible name and ordinal next to the ref, so a trace recorded
yesterday still hits the right button today. If the page no longer matches the recorded state, the
player reports a divergence and **refuses to click blind**:

```
DIVERGED step 1 (page-hash): expected 0481f729084db35d, got 3d183a5bda1f3e4b — before mouse.click
```

Exit code is 1 on any divergence or failed step, so it drops straight into CI.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot mount AppImage` / FUSE error | No FUSE on the host | `--appimage-extract-and-run` |
| Window opens, then closes instantly | Sandbox refused by the kernel | `ZIMREAPER_NO_SANDBOX=1` |
| Agent connects but every click times out | It is talking to a browser whose window is unmapped | Use the GUI or `ZIMREAPER_SERVE=1`, never a bare hidden window |
| `ECONNREFUSED ws://127.0.0.1:7420` | The app is not running, or it picked another port | Start the app; read the real port from `~/.zimreaper/endpoint.json` |
| `UNAUTHORIZED (4401)` | Token mismatch — usually a stale `control.token` | Delete `~/.zimreaper/control.token` and restart the app |
| `BLOCKED_BY_POLICY` | Origin not trusted for that action | Add the origin to `policy.json` with a tier |
| `browser_task` needs a model | No provider key | Export `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, or use the MCP tools directly |
| Tools missing in the client | Client caches MCP tool lists | Restart the client; `AppImage mcp` alone should print nothing and wait |

Diagnostics:

```bash
~/Applications/ZimReaper-0.1.0-x86_64.AppImage info
~/Applications/ZimReaper-0.1.0-x86_64.AppImage audit verify
~/Applications/ZimReaper-0.1.0-x86_64.AppImage mcp --connect ws://127.0.0.1:7420 --token "$(cat ~/.zimreaper/control.token)"
```

---

## Build from source

```bash
git clone <repo> && cd ZIMREAPER
npm install
npm run build
npm test

npm run fixture          # deterministic test site on http://127.0.0.1:4310
npm run dev:desktop      # Electron shell, control server on ws://127.0.0.1:7420
```

Verification (all of it runs against real Chromium, no mocks):

| Check | Command | Result |
|---|---|---|
| Unit + integration suite | `npm test` | 229 passed, 3 skipped |
| Real mouse/keyboard journey | `npm run check:p0` | 14/14 |
| MCP surface, self-launching | `npm run check:mcp` | 21 tools, PASS |
| Superhuman capabilities | `npm run check:capabilities` | 6/6 |
| Record → replay → divergence | `npm run check:replay` | 4/4 |
| Packaged AppImage (CLI + MCP + serve + attach) | `npm run check:appimage` | 4/4 |

Package it:

```bash
npm run package:linux    # -> dist/ZimReaper-0.1.0-x86_64.AppImage (~97 MB)
```

More detail: `docs/packaging.md`, `docs/agent-prompt.md`, `docs/protocol.md`,
`docs/mcp-setup.md`, `ARCHITECTURE.md`, `PLAN.md`.

---

## Repo layout

```
packages/protocol     zod schemas, error taxonomy (frozen wire contract)
packages/perception   accessibility snapshot, stable refs, diff, token budget
packages/replay       record/replay traces, ref re-binding, divergence detection
packages/policy       trust tiers, approvals, hash-chained audit
packages/core         backend (CDP/Electron), executor, control server + client
packages/agent        provider-agnostic agent loop (OpenAI-compatible + Anthropic)
packages/mcp-server   21 MCP tools, stdio + HTTP
packages/cli          zimreaper CLI
apps/desktop          Electron shell: tabs, HUD, ghost cursor
fixtures/site         deterministic test target
tests/e2e             Playwright + Electron journeys
```

---

## Author

**Mr-Destroyer** — aka **zim**
YouTube: **[study_hard69](https://www.youtube.com/@study_hard69)**

If you build something with this, break something with this, or find a site it cannot drive — say
so on the channel. That is the point of shipping it.

License: MIT.
