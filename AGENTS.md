# AGENTS.md — ZimReaper team contract

You are one of six agents building ZimReaper in a shared working tree. Read this before you
write code. The lead (hermes-lead, pane w8:p1) integrates and verifies.

## Product in one line

A desktop browser that agents drive with real human input primitives (mouse, keyboard, wheel,
drag) plus superhuman ones (network surgery, replay, perception diff, fleets), under a human
trust boundary, exposed over MCP.

Read `PLAN.md` and `ARCHITECTURE.md`. `docs/protocol.md` is the contract.

## Hard rules

1. **Stay in your lane.** Only edit files under the paths you own (table below). Never edit
   `packages/protocol/**`, root config, or another agent's package. If you need a change there,
   message the lead: `herdr agent prompt hermes-lead "<request>"`.
2. **Do not run git.** No add/commit/checkout/stash. The lead commits. Concurrent git use
   corrupts the index.
3. **Do not run `npm install`.** Dependencies are installed. If you truly need a new one, add it
   to your own `package.json` and tell the lead in your report.
4. **Do not change the protocol shape.** It is frozen for P0. Additive optional fields are OK
   only after the lead agrees.
5. **Every exported symbol is typed.** `strict: true`, no `any` in public signatures, no
   non-null `!` on values that can be absent at runtime.
6. **All failures are `ZimReaperError`** with a code from `packages/protocol`. Never let a raw
   CDP error or DOM exception escape a package boundary.
7. **Tests are part of the deliverable.** Unit tests in `packages/<yours>/test/*.test.ts` or
   `src/*.test.ts`. Run them before reporting.
8. **Report in the fixed format** at the end of your turn (see bottom).

## Ownership map

| Agent name | Pane | Owns |
|---|---|---|
| hermes-lead | w8:p1 | `packages/protocol`, `docs/`, root config, integration |
| hermes-core | w8:p2 | `packages/core` |
| hermes-perception | w8:p3 | `packages/perception` |
| codex-shell | w8:p4 | `apps/desktop` |
| codex-gateway | w8:p5 | `packages/mcp-server`, `packages/agent`, `packages/cli` |
| opencode-policy | w8:p6 | `packages/policy`, `fixtures/site`, `tests/e2e` |

## Commands

```bash
npm run build            # tsc -b all packages (lead runs; you run yours)
npm run typecheck        # tsc -b --noEmit-ish via project refs
npm test                 # vitest run, all workspaces
npm test -w @zimreaper/core          # your package only
npm run e2e              # Playwright + Electron + fixture site
npm run dev:desktop      # launch Electron shell (needs a display)
```

Per-package build: `npx tsc -b packages/core`. Do not run the root build while another agent is
mid-edit; prefer your own package build plus `npm test -w <yours>`.

## Conventions

- ESM only (`"type": "module"`), Node 22+ APIs, no CJS `require`.
- File names: `kebab-case.ts`. Types/interfaces: `PascalCase`. Functions: `camelCase`.
- Prefer pure functions in perception/policy (testable without a browser).
- Logging: `createLogger(scope)` from core; never `console.log` in library code (CLI/HUD only).
- Timeouts: every await on the browser gets a deadline. Default action timeout 15 s, nav 30 s.
- Comments explain *why*, not *what*. No banner comments.
- No new runtime dependency without telling the lead. Dev deps are fine if already installed.

## Testing expectations

- core: unit tests for the executor's ref resolution, error mapping, and the WS server framing
  against an in-memory fake backend.
- perception: golden-file tests over captured AX/DOM fixtures; diff tests; budget tests.
- policy: table-driven tests for the action classifier, origin tiers, approval flow, hash chain.
- mcp-server/agent: tool-schema snapshot test; loop test against a scripted fake provider.
- desktop: Playwright Electron smoke test (window opens, tab loads fixture, HUD renders).
- e2e: one full journey through the bus with real mouse events on the fixture site.

## Report format (end of every turn)

```
DONE: <one line>
FILES: <paths added/changed>
TESTS: <command> -> <pass/fail counts>
CONTRACT: <any deviation from protocol/docs, or "none">
NEXT: <what the lead should integrate or what you need>
```

If blocked, say `BLOCKED:` with the exact error and what you need from the lead. Do not silently
work around a protocol problem.
