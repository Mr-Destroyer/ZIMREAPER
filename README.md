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

What the smoke actually proves: Chromium is driven over CDP, the agent gets a 640-char
token-budgeted snapshot with 13 stable refs, a click resolves a ref to a box-model centre and
dispatches `mouseMoved → mousePressed → mouseReleased`, typing goes through
`dispatchKeyEvent`/`insertText`, the form submits, the welcome page renders, every action lands
in a hash-chained audit log, and a click on an unknown origin is refused with
`BLOCKED_BY_POLICY` under strict policy.

Not done yet (see `PLAN.md` phases P1–P3): deterministic replay, page watches while the app is
closed, parallel tab fleets, packaged installers, VLM-backed `vision.ground` (today it is a
name/role match against the snapshot), and site playbooks.

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
packages/policy       trust tiers, approvals, audit chain
packages/core         Backend (CDP/Electron), executor, control server + client
packages/agent        provider-agnostic loop
packages/mcp-server   MCP tools (stdio + HTTP)
packages/cli          zimreaper CLI
apps/desktop          Electron shell (tabs, HUD, ghost cursor)
fixtures/site         deterministic test target
tests/e2e             Playwright + Electron journeys
```
