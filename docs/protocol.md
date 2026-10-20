# ZimReaper protocol (v0.1.0)

One transport, three callers (HUD, CLI, MCP server). JSON-RPC 2.0-shaped frames over a
WebSocket bound to `127.0.0.1`, bearer token required in the first frame.

## Handshake

```json
{"jsonrpc":"2.0","id":"1","method":"ping","params":{"token":"<control.token>","client":"mcp"}}
```

Failure closes the socket with code 4401. Every later frame inherits the session.

## Requests

```json
{"jsonrpc":"2.0","id":"a17","method":"act","tabId":"t3","timeoutMs":15000,
 "params":{"kind":"mouse.click","target":{"ref":"e12"},"button":"left","clickCount":1,
           "modifiers":[],"delayMs":24}}
```

- `method`: `act` (mutating, policy-gated), `query` (read-only), `cancel`, `ping`.
- `tabId` optional; defaults to the active tab.
- `params` is validated by `ActionSchema` / `QuerySchema` in `packages/protocol`.

## Responses

```json
{"jsonrpc":"2.0","id":"a17","ok":true,
 "result":{"clicked":{"x":540,"y":428},"ref":"e12"},
 "meta":{"tabId":"t3","url":"https://example.com/login","ms":61,"snapshotId":"s7f3a"}}
```

```json
{"jsonrpc":"2.0","id":"a17","ok":false,
 "error":{"code":"STALE_REF","message":"ref e12 is from generation 3; current is 5","retryable":true}}
```

## Events

```json
{"jsonrpc":"2.0","method":"event","params":{"kind":"action.finished","id":"a17","kind":"mouse.click","ok":true,"ms":61}}
```

Event kinds: `tab.*`, `nav.*`, `console.message`, `net.*`, `dialog.opened`, `download.*`,
`action.*`, `human.input`, `human.released`, `agent.status`, `approval.requested`,
`approval.resolved`, `audit.entry`.

## Snapshots and refs

`page.snapshot` returns `{snapshotId, generation, text, refs[], pageHash}`. The `text` field is
what the model reads:

```
page: "Sign in — Example"  url=https://example.com/login  viewport=1280x800  scroll=0/0  snap=s7f3a
[e1] textbox "Email" value="" @(412,318) 240x36
[e2] textbox "Password" value="" @(412,368) 240x36
[e3] button "Sign in" @(412,428) 240x40
```

Refs are valid for one generation per tab. Using an old ref returns `STALE_REF` (retryable), which
tells the agent to re-snapshot rather than guess. `page.diff {since}` returns only changes.

## Error codes

`BAD_REQUEST, UNAUTHORIZED, NOT_FOUND, STALE_REF, NO_TARGET, TIMEOUT, NAV_FAILED, TAB_CLOSED,
BLOCKED_BY_POLICY, NEEDS_HUMAN, CANCELLED, BACKEND_ERROR, UNSUPPORTED, INTERNAL`

## MCP tool mapping

| MCP tool | Protocol call |
|---|---|
| `browser_navigate` | `act nav.goto` |
| `browser_snapshot` | `query page.snapshot` |
| `browser_click` | `act mouse.click` (ref/selector) |
| `browser_type` | `act key.type` |
| `browser_press` | `act key.press` / `key.chord` |
| `browser_drag` | `act mouse.drag` |
| `browser_scroll` | `act page.scroll` |
| `browser_screenshot` | `act page.screenshot` |
| `browser_wait` | `act page.wait` |
| `browser_tabs` | `query tab.list` / `act tab.new` / `tab.close` |
| `browser_network` | `query net.log` / `net.body` |
| `browser_network_surgery` | `act net.route` / `net.replay` |
| `browser_extract` | `query page.extract` |
| `browser_eval` | `act page.eval` |
| `browser_fork_session` | `act session.fork` |
| `browser_task` | native agent loop (no single protocol call) |
