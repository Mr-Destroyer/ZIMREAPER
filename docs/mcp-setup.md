# Connecting agents to ZimReaper

ZimReaper exposes one MCP server. The browser app hosts the control server; the MCP process is a
thin adapter. Discovery is a file so every harness uses the same wiring.

## Discovery file

When the app (or `zimreaper attach`) starts the control server it writes:

```
~/.zimreaper/endpoint.json      (0600)
{
  "url": "ws://127.0.0.1:53412",
  "port": 53412,
  "token": "<32-byte hex>",
  "sessionId": "s_ab12cd",
  "pid": 41233,
  "startedAt": 1761087600000,
  "appVersion": "0.1.0"
}
```

The CLI reads it automatically. If it is missing or stale, `zimreaper mcp --launch` starts a
headless Chromium and serves the same tools without the desktop shell.

## Claude Code

```bash
claude mcp add zimreaper -- node /home/zim/Projects/ZIMREAPER/packages/cli/dist/bin.js mcp
```

Or over HTTP (the app must be running):

```bash
claude mcp add --transport http zimreaper http://127.0.0.1:7421/mcp/<path-token>
```

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`~/.config/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "zimreaper": {
      "command": "node",
      "args": ["/home/zim/Projects/ZIMREAPER/packages/cli/dist/bin.js", "mcp"]
    }
  }
}
```

## Hermes Agent

```bash
hermes mcp add zimreaper --command node \
  --args /home/zim/Projects/ZIMREAPER/packages/cli/dist/bin.js mcp
hermes mcp test zimreaper
```

## Codex CLI

```bash
codex mcp add zimreaper -- node /home/zim/Projects/ZIMREAPER/packages/cli/dist/bin.js mcp
```

Equivalent `~/.codex/config.toml` block:

```toml
[mcp_servers.zimreaper]
command = "node"
args = ["/home/zim/Projects/ZIMREAPER/packages/cli/dist/bin.js", "mcp"]
startup_timeout_sec = 20
```

## OpenCode

`opencode.json`:

```json
{
  "mcp": {
    "zimreaper": {
      "type": "local",
      "command": ["node", "/home/zim/Projects/ZIMREAPER/packages/cli/dist/bin.js", "mcp"],
      "enabled": true
    }
  }
}
```

## Tools the agent gets

| Tool | What it does |
|---|---|
| `browser_navigate` | go to a URL, back/forward/reload, wait policy |
| `browser_snapshot` | token-budgeted AX view with `eN` refs |
| `browser_diff` | only what changed since a snapshot |
| `browser_click` | real mouse press/release at a ref, selector, or point |
| `browser_type` | focus + type with per-key events |
| `browser_press` | single key or chord (`Control+Shift+T`) |
| `browser_drag` | press, N interpolated moves, release |
| `browser_scroll` | wheel at a point or to top/bottom |
| `browser_screenshot` | png/jpeg, full page, set-of-marks |
| `browser_wait` | selector/text/url/network-idle/ref-gone |
| `browser_tabs` | list, new, close, activate |
| `browser_eval` | run JS in page or isolated world |
| `browser_extract` | rows + fields to structured JSON |
| `browser_network` | log, bodies, block/mock, replay with overrides |
| `browser_cookies` | read/write cookies and local storage |
| `browser_set_viewport` | resize / emulate device |
| `browser_fork_session` | clone a logged-in session into N tabs |
| `browser_ask_human` | park the action for approval |
| `browser_task` | run the native loop on a natural-language task |

## Trust defaults

- Unknown origins are `read` tier: navigation and observation only. Clicking a form field on a
  new site requires either a policy entry or an approval prompt in the HUD.
- Payment/send/delete/publish actions always require approval unless the origin is explicitly
  `transact`.
- `Escape` in the browser window kills all agent activity immediately.
