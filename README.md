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

P0 foundation under construction. The protocol is frozen; packages are being implemented in
parallel by the herdr team.

## Quick start

```bash
npm install
npm run build
npm test
npm run fixture            # fixture site on http://127.0.0.1:4310
npm run dev:desktop        # Electron shell
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
