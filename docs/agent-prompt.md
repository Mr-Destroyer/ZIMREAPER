# Agent instructions (paste this into your agent)

Most models drive the browser badly on the first try: they click stale refs, re-read the whole page
after every step, and reach for `eval` when a click would do. Paste the block below into your
system prompt, project rules, `AGENTS.md`, or a Claude Code `CLAUDE.md`.

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

## Why each rule exists

| Rule | Failure it prevents |
|---|---|
| 1, 2 | Refs are per-snapshot generations. A ref from three actions ago may point at a different element, or at nothing. |
| 3 | Re-snapshotting a 4,000-node page after every click burns the context window and buries the one changed row. |
| 4 | Sleeps are the most common cause of flaky runs; the wait primitive resolves on the real condition. |
| 5 | `eval` is gated because it bypasses the human-visible input path that the audit log and policy tiers are built around. |
| 6 | `extract` runs the selection inside the page and returns typed rows; hand-scraping text loses structure and costs tokens. |
| 7 | Policy refusals are a trust decision, not a bug. The human can grant the origin in `~/.zimreaper/policy.json`. |
| 8 | An agent that retries a failing step silently is indistinguishable from a loop; handing over is the correct behaviour. |
| 9 | "Done" without the URL and the verified text is not evidence. |

## Verify your wiring

```bash
# does the agent see the tools?
~/Applications/ZimReaper-0.1.0-x86_64.AppImage mcp        # connects to the running app, waits on stdio

# is the app it will attach to alive?
~/Applications/ZimReaper-0.1.0-x86_64.AppImage info
```
