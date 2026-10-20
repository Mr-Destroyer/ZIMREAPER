# ZimReaper Architecture

## 1. Process and package layout

```
┌──────────────────────────── Electron app (apps/desktop) ────────────────────────────┐
│ main process (Node/ESM)                                                             │
│   ├─ TabManager (WebContentsView per tab, session partitions)                       │
│   ├─ ElectronBackend  ── webContents.debugger.sendCommand(CDP) ──► tab renderers    │
│   ├─ ControlServer (ws://127.0.0.1:<port>, bearer token, 0600 token file)           │
│   ├─ Executor + Perception + Policy (packages/*)                                    │
│   └─ IPC bridge ──► renderer (React): chrome UI, HUD, ghost cursor, approvals       │
└─────────────────────────────────────────────────────────────────────────────────────┘
        ▲ JSON-RPC over ws                    ▲ stdio / streamable HTTP
        │                                     │
  packages/cli (zimreaper run|mcp|attach)   MCP clients (Claude, Hermes, Codex)

Headless / CI path:  packages/core CdpBackend ── ws://127.0.0.1:9222 ──► system Chromium
```

`Backend` is the seam. It exposes CDP verbs, not browser concepts:

```ts
interface Backend {
  listTabs(): Promise<TabInfo[]>;
  createTab(opts: CreateTabOptions): Promise<TabInfo>;
  closeTab(tabId: string): Promise<void>;
  activateTab(tabId: string): Promise<void>;
  send<T>(tabId: string, method: string, params?: object): Promise<T>;
  on(handler: (e: BackendEvent) => void): () => void;
  capabilities(): BackendCapabilities;
  close(): Promise<void>;
}
```

Two implementations: `CdpBackend` (raw WebSocket to a Chromium debug port; used by tests and by
`zimreaper attach` to an existing browser) and `ElectronBackend` (in-process `webContents.debugger`).
The executor, perception, policy, MCP server and agent loop never know which one is running.

## 2. Action lifecycle

```
agent ──tool call──► MCP server ──RPC──► ControlServer
                                             │
                                    1. authenticate (token, origin)
                                    2. resolve tab (explicit > active)
                                    3. policy.preflight(action, context)
                                        ├─ BLOCK  -> BLOCKED_BY_POLICY
                                        ├─ CONFIRM-> human approval via HUD (NEEDS_HUMAN)
                                        └─ ALLOW
                                    4. executor.resolve(action)
                                        ├─ ref -> bbox via DOM.getBoxModel
                                        └─ selector -> querySelector -> box model
                                    5. backend.send(tab, "Input.dispatchMouseEvent", …)
                                    6. settle (network idle | frame | quiet period)
                                    7. perception.snapshot() if requested
                                    8. policy.record(audit entry, hash-chained)
                                             │
◄────────── {ok, result, meta:{tabId,url,ms,snapshotId}} ───────────────────────────┘
```

Cancellation: every request has an `AbortSignal`; `session.cancel` aborts the in-flight action and
any queued action for that tab. Human input (real mouse/keyboard captured by the shell) emits
`human.input`, which pauses the agent loop for that tab until `human.release`.

## 3. Refs and snapshots

A snapshot is one pass over the accessibility tree, pruned and budgeted:

```
page: "Sign in — Example"  url=https://…  viewport=1280x800  scroll=0/2140  snap=s7f3a
[e1] textbox "Email" value="" @(412,318) 240x36
[e2] textbox "Password" value="" @(412,368) 240x36
[e3] button "Sign in" @(412,428) 240x40
[e4] link "Forgot password?" @(470,486) 96x18
```

- `eN` refs are allocated per tab per snapshot generation, stored in a server-side map:
  `{ref, backendNodeId, selector, bbox, role, name, textHash, generation}`.
- Actions accept `ref` or `selector` or raw `{x,y}`. Ref wins, selector is a fallback, raw point
  is the escape hatch for canvas.
- Resolution failure returns `STALE_REF` (not a silent miss) with the current generation, so the
  agent re-snapshots instead of flailing.
- `page.diff {since}` returns added/removed/changed refs only, keyed by `textHash` + role + name.
  This is what keeps long loops affordable.

Budgeting: interactive roles first (button, link, textbox, checkbox, radio, combobox, menuitem,
tab), then text in the viewport, then offscreen text truncated. `maxChars` default 12k. Every
truncation is marked in-band so the agent knows it is missing data.

## 4. Perception beyond the DOM

- **SoM screenshots**: `page.screenshot {annotate:true}` draws numbered boxes over interactive
  elements and returns `{image, marks:[{n, ref, bbox}]}` so a vision model can answer "click 12".
- **Vision grounding**: `vision.ground {description}` asks the configured VLM for a point, snaps
  it to the nearest mark if within 24 px, then the executor dispatches a real mouse click.
- **Frames**: same-origin frames are walked by CDP; cross-origin frames are separate CDP sessions
  (out-of-process iframes) and are snapshotted as their own targets when `includeFrames` is set.

## 5. Trust boundary

Page content is untrusted. Concretely:

1. **Taint.** Every string that came from the page (DOM text, network body, clipboard) is tagged
   `untrusted` as it enters the model context. The agent loop refuses to execute a *privileged*
   action whose rationale quotes tainted text unless the policy allows it.
2. **Origin tiers** (`~/.zimreaper/policy.json`): `read` (default) → `interact` → `transact`.
   `transact` covers payment, publish, send, delete, permission grants, credential reveal.
3. **Classifier.** Deterministic rules over (action kind, target role/name, origin, taint) produce
   ALLOW / CONFIRM / BLOCK. Rules are data, not code paths sprinkled through the executor.
4. **Approval.** CONFIRM parks the action and emits a HUD prompt with a screenshot + args diff.
   Default deny on timeout. Every approval is audited with who/when/what.
5. **Credentials.** Stored in the OS keyring via Electron `safeStorage`. Agents address them by
   name (`vault.fill(ref, "example.com/login")`); plaintext never enters a prompt or the audit log.
6. **Audit chain.** `~/.zimreaper/audit/YYYY-MM-DD.jsonl`, each entry
   `{seq, ts, actor, tabId, url, action, argsHash, result, prevHash, hash}`. `zimreaper audit verify`
   recomputes the chain.
7. **Kill switch.** `Esc` in the shell (or `session.kill`) aborts all loops, releases input, and
   writes a `kill` audit entry.

## 6. Storage

```
~/.zimreaper/
  control.token          0600, regenerated per app start
  policy.json            origin tiers, allowlists, approval rules
  profiles/<id>/         Chromium session partitions (cookies, storage)
  playbooks/<domain>.json learned steps + selector health
  audit/YYYY-MM-DD.jsonl hash-chained action log
  artifacts/<session>/   screenshots, HAR, extracted data
  memory.json            site notes, task outcomes (no secrets)
```

No SQLite in P0: JSONL + atomic JSON writes keep Electron's native-module rebuild problem out of
the critical path. SQLite lands in P2 behind the same store interfaces.

## 7. Failure semantics

| Code | Meaning | Agent should |
|---|---|---|
| `BAD_REQUEST` | schema violation | fix the call |
| `NOT_FOUND` | no such tab/ref/request | re-snapshot / re-list |
| `STALE_REF` | ref from an older generation | re-snapshot, retry once |
| `NO_TARGET` | ref/selector matched nothing | re-snapshot, try selector or vision |
| `TIMEOUT` | deadline hit | inspect state, retry with longer timeout |
| `NAV_FAILED` | net error / 4xx-5xx on goto | report, try alternate URL |
| `BLOCKED_BY_POLICY` | classifier said no | stop, ask human |
| `NEEDS_HUMAN` | parked for approval | wait or ask |
| `TAB_CLOSED` | target died mid-action | pick another tab |
| `CANCELLED` | aborted by kill/cancel | stop |
| `BACKEND_ERROR` | CDP/Electron failure | retry once, then report |

Retries are the agent's job, not the executor's — the executor never silently retries a mutating
action.

## 8. Test strategy

- **Unit**: pure perception/policy, executor against a fake backend that records CDP verbs.
- **Integration**: `CdpBackend` against system Chromium (headless) on a random port, fixture site
  served by `fixtures/site/server.mjs`.
- **E2E**: Playwright `_electron` launches the real app, drives one journey through the control
  bus, asserts DOM state, audit chain, and HUD event stream.
- **Golden files**: snapshot output for the fixture pages, so perception changes are visible in
  diffs rather than vibes.
