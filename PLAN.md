# ZIMREAPER — Product & Build Plan

## 1. What we are building

ZimReaper is a desktop browser that an AI agent can drive with the same primitives a human
has — real mouse movement, clicks, drags, wheel, keyboard, IME, file pickers — plus primitives
humans do not have: parallel tab fleets, network surgery, deterministic replay, perception
diffing, page watches, schema-driven extraction, and per-site playbooks that make every run
faster than the last.

Three surfaces, one action bus:

| Surface  | Shape | Who uses it |
|----------|-------|-------------|
| Human    | Electron browser: tabs, address bar, agent HUD, ghost cursor, take-over | the operator |
| Agent    | MCP server (stdio + streamable HTTP) + native agent loop | Claude Desktop/Code, Hermes, Codex, any MCP client |
| Operator | `zimreaper` CLI + local JSON-RPC control API (token-gated, 127.0.0.1 only) | scripts, CI, power users |

The action bus is the product. The browser is its body, the agent is its pilot, the human is
its authority.

## 2. Why this wins

| Existing approach | What it gets wrong |
|---|---|
| Chat-sidebar browsers (Comet, Atlas, Dia) | Thin DOM tool layer; no real input fidelity; no audit; agent and human fight over one tab |
| Headless automation (Playwright/Puppeteer, Browser Use) | No human co-presence, no visual truth, selector brittleness, no trust boundary |
| RPA (UiPath-style) | Pixel macros with no perception and no recovery |
| Browser MCP servers | 10-20 tools, no session model, no policy, no replay |

ZimReaper's bet: **fidelity + perception + trust + replay**. An agent that can move a real
cursor and read a compressed, diffed view of the page is qualitatively more capable than one
that calls `element.click()` on a guessed selector — and it is auditable, which is what makes
it deployable in a company.

## 3. Differentiators (ranked, with v1 scope)

D1 — **Real input fidelity.** Every action goes through CDP `Input.*` at real coordinates with
real timing: move with interpolation, click with press/release, drag with steps, wheel with
deltas, keys with chords, text with per-character delay. Element-level `click(ref)` is sugar
that resolves a box model and then still dispatches a real mouse event at its center.
v1: move/click/dblclick/rightclick/drag/wheel/type/press/chord/hover/select/upload.

D2 — **Perception diffing.** Every snapshot carries a content hash per node. `page.diff` returns
only what appeared, vanished, or changed since the last look, so an agent loop pays tokens for
deltas instead of re-reading the page. v1: AX-tree snapshot + diff + stable refs.

D3 — **Network surgery.** Capture HAR, inspect request/response bodies, block, mock, rewrite,
and replay any request with mutations. The agent can answer "what did the site send back" and
"what happens if I change this field" without a proxy setup. v1: log + body + block/mock +
replay-with-overrides.

D4 — **Parallel fleets.** `fleet.run(tasks, concurrency)` opens isolated tabs (optionally forked
logged-in sessions), runs one agent loop per tab, and returns structured results. v1: N tabs,
per-tab loop, aggregate result.

D5 — **Deterministic replay.** Every action is recorded with args, resolved target, and page
hash. `replay.run(id)` re-executes with drift detection and fails loudly at the first divergent
step; `replay.export` emits a Playwright test. v1: record + replay + drift report.

D6 — **Trust boundary.** Page content is untrusted input by definition. Instructions found in
the DOM are tainted, cannot trigger privileged actions, and destructive actions (pay, send,
delete, publish, permission grants) require explicit human approval unless a policy pre-authorizes
the origin. Append-only hash-chained audit log. v1: origin tiers, action classifier, approval
gate, audit chain, kill switch.

D7 — **Playbooks / site memory.** Successful runs distill into per-domain playbooks (selectors,
waits, step order). Next run starts from the playbook, verifies, and falls back to perception.
v1: JSON playbook store + lookup + verification.

D8 — **Human co-presence.** Ghost cursor and action log in the HUD, instant take-over (any real
human input pauses the agent), approval prompts inline. v1: HUD event stream, take-over, approvals.

D9 — **Vision grounding.** For canvas/WebGL/cross-origin iframes where the DOM is useless:
screenshot → set-of-marks → coordinates → real mouse. v1: SoM screenshot + point-from-VLM hook
(pluggable; heuristic fallback).

D10 — **Session forking.** Duplicate a logged-in tab into N isolated tabs with copied cookies +
storage, so a fleet can act in parallel without re-authenticating. v1: cookie/storage copy.

## 4. Architecture

See `ARCHITECTURE.md`. Short version:

```
 MCP client / CLI / HUD
        │  JSON-RPC (ws, token)
        ▼
  Control server ──► Policy (trust tiers, approvals, audit)
        │
        ▼
   Executor ──► Backend (CDP) ──► Chromium (Electron WebContentsView | system chromium)
        │
        ▼
   Perception (AX tree, refs, SoM, diff, budget)
```

`Backend` is the only Chromium-shaped interface (`send(tabId, cdpMethod, params)`), which is why
the whole control plane is testable headless against system Chromium and runs unchanged inside
Electron.

## 5. Phases and exit criteria

**P0 — Foundation (this session).** Monorepo, frozen protocol, control server, CDP backend,
Electron shell with tabs, perception v1, MCP v1, agent loop v1, policy v1, fixture site, E2E.
Exit: `npm test` green; E2E drives a real form through the bus with real mouse events; an MCP
tool call completes the same flow; audit log contains a valid hash chain.

**P1 — Depth.** Network surgery, stable refs across navigations, diff-based loops, replay,
session fork, OS keyring credentials, HUD polish, download/dialog/upload handling.

**P2 — Leverage.** Fleets, watches (background service, works with window closed), extraction
schemas → CSV/JSON, playbooks, vision grounding, multi-profile.

**P3 — Ship.** AppImage/dmg packaging, auto-update, crash reporting (opt-in), team audit export,
docs site, benchmark suite (task success rate vs. Playwright-MCP baseline).

## 6. Team and ownership

| Agent | Owns | Deliverable |
|---|---|---|
| lead (w8:p1) | `packages/protocol`, docs, root config, integration, verification | contract, green build, final report |
| hermes-core (w8:p2) | `packages/core` | backend interface + CDP backend, tab manager, executor, control server + client |
| hermes-perception (w8:p3) | `packages/perception` | AX/DOM snapshot, refs, SoM, diff, budgeter, extraction |
| codex-shell (w8:p4) | `apps/desktop` | Electron main/preload/renderer, tabs, HUD, ElectronBackend, build config |
| codex-gateway (w8:p5) | `packages/mcp-server`, `packages/agent`, `packages/cli` | MCP tools, provider-agnostic loop, CLI |
| opencode-policy (w8:p6) | `packages/policy`, `fixtures/site`, `tests/e2e` | trust tiers, approvals, audit chain, vault iface, fixture site, E2E |

## 7. Quality bar

- TypeScript strict, ESM, no `any` in exported signatures, zod at every boundary.
- One error type (`ZimReaperError`) with a stable code taxonomy; no raw throws across packages.
- Unit tests per package (vitest). E2E against a local fixture site (Playwright + system Chromium).
- Perf budgets: snapshot ≤150 ms on 1k nodes; click ≤30 ms after ref resolution; app cold start ≤2 s.
- No secrets in logs, prompts, or audit args. Credentials never leave the vault except into a field.
- Every action is cancellable; every wait has a timeout; no unbounded loops.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Electron on Wayland is flaky in CI | CDP backend is the primary test target; Electron smoke test is separate |
| Ref staleness breaks clicks | generation counter + `STALE_REF` error + auto re-snapshot hint |
| Prompt injection from page content | taint tracking, policy gate, approval for destructive actions |
| Agents collide in one working tree | strict file ownership, frozen protocol, lead integrates |
| Scope creep | phase gates; P0 exit criteria are binary |
| CDP version drift | `capabilities()` probe at startup, feature-detect optional domains |

## 9. Non-goals

- Writing a browser engine. We drive Chromium.
- CAPTCHA solving or anti-bot evasion as a marketed feature (fingerprint/profile management is
  supported for legitimate multi-account QA, not for fraud).
- Cloud sync, team SaaS, or telemetry in v1.
