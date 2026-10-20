# ZIMREAPER

An agentic desktop browser. Agents drive it with real human input primitives — mouse movement,
clicks, drags, wheel, keyboard — plus superhuman ones: perception diffing, network surgery,
deterministic replay, parallel tab fleets, and per-site playbooks. One action bus, three callers
(HUD, CLI, MCP).

- Product and phases: `PLAN.md`
- Architecture and trust model: `ARCHITECTURE.md`
- Wire protocol: `docs/protocol.md`
- Team contract: `AGENTS.md`

## Status

P0 is green end to end. Verified on this machine with real Chromium, real input events:

| Check | Command | Result |
|---|---|---|
| Unit/integration suite | `npm test` | 212 passed, 3 skipped |
| Real-browser journey (mouse + keyboard login) | `node scripts/p0-smoke.mjs` | 13/13 checks |
| MCP surface, self-launching | `node scripts/mcp-check.mjs` | 21 tools, PASS |
| MCP surface, attached to running app | `node scripts/mcp-check.mjs --attach` | PASS |
| Electron shell boot | `ZIMREAPER_HEADLESS_SMOKE=1 npm start -w @zimreaper/desktop` | `desktop-ready 7420` |
| HUD DOM (tabs, HUD, event stream) | `node scripts/shot.mjs` | 1 tab, 13 controls, live event feed |
| Superhuman capabilities | `node scripts/capabilities-check.mjs` | 6/6 checks |
| Record -> replay -> divergence | `node scripts/replay-check.mjs` | 4/4 checks |

Superhuman capabilities, each verified against the fixture site:

| Capability | What the check proves |
|---|---|
| `page.extract` | 25 table rows x 3 fields returned as structured JSON, no CSS knowledge from the caller |
| `page.diff` | after an async load, only the 5 new items are reported — the agent never re-reads the page |
| `net.log` | the full 3-hop fetch chain the page performs internally is visible to the agent |
| `storage.cookies` | cookie jar written and read back outside the page |
| `session.fork` | one live tab cloned into 2 more isolated tabs (1 -> 3) |
| `page.eval` | policy-gated JS evaluation in the page |

What the smoke actually proves: Chromium is driven over CDP, the agent gets a 640-char
token-budgeted snapshot with 13 stable refs, a click resolves a ref to a box-model centre and
dispatches `mouseMoved → mousePressed → mouseReleased`, typing goes through
`dispatchKeyEvent`/`insertText`, the form submits, the welcome page renders, every action lands
in a hash-chained audit log, and a click on an unknown origin is refused with
`BLOCKED_BY_POLICY` under strict policy.

### Replay

`@zimreaper/replay` records an agent run as JSONL and re-runs it as a test. Refs are session
scoped, so every recorded target also stores the element's role, accessible name and ordinal;
the player re-binds the ref by identity before acting. When the page no longer matches the
recorded hash, the player reports a divergence and refuses to click blind.

```bash
node scripts/replay-check.mjs                       # record, replay in a fresh tab, prove divergence
zimreaper replay trace.jsonl --url http://host/login # exits 1 on any divergence or failed step
zimreaper replay trace.jsonl --continue --json       # keep going past divergence, machine output
```

Verified: 6 steps recorded with 3 ref identities and 2 checkpoints, 6/6 replayed in a fresh tab in
1.9s with the same end state, and the same trace against a different page yields
`page-hash` divergence with zero clicks dispatched.

Not done yet (see `PLAN.md` phases P1–P3): page watches while the app is closed, parallel tab
fleets, packaged installers, VLM-backed `vision.ground` (today it is a name/role match against
the snapshot), and site playbooks.

## Quick start

```bash
npm install
npm run build
npm test

npm run fixture            # fixture site on http://127.0.0.1:4310
npm run dev:desktop        # Electron shell (control server on ws://127.0.0.1:7420)

node scripts/p0-smoke.mjs  # drive the real browser end to end
node scripts/mcp-check.mjs # exercise the MCP tools
```

## Layout

```
packages/protocol     zod schemas, error taxonomy (frozen)
packages/perception   AX snapshot, refs, SoM, diff, budget
packages/replay       record/replay traces, ref re-binding, divergence detection
packages/policy       trust tiers, approvals, audit chain
packages/core         Backend (CDP/Electron), executor, control server + client
packages/agent        provider-agnostic loop
packages/mcp-server   MCP tools (stdio + HTTP)
packages/cli          zimreaper CLI
apps/desktop          Electron shell (tabs, HUD, ghost cursor)
fixtures/site         deterministic test target
tests/e2e             Playwright + Electron journeys
```
