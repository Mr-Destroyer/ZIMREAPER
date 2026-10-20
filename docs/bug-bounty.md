# ZIMREAPER for bug bounty and security testing

ZIMREAPER exists because the browser is where bug bounty actually happens, and the tools that drive
it were built for something else. Selenium and headless scrapers dispatch synthetic DOM events that
half the modern web ignores; a human with a proxy sees traffic no API client can guess at.

This page is the hunting workflow, not the feature list.

**Authorized testing only.** Everything below assumes a program scope you are allowed to test. The
policy file is where that scope belongs.

---

## 1. Point the browser at your proxy

The single most important switch for a hunter:

```bash
export ZIMREAPER_PROXY=http://127.0.0.1:8080     # mitmproxy, Burp, ZAP
export ZIMREAPER_INSECURE=1                      # accept the proxy CA (TLS interception)

~/Applications/ZimReaper-0.1.0-x86_64.AppImage
```

Every request the browser makes now lands in your proxy, including **loopback targets**. Chromium
normally bypasses proxies for `127.0.0.1`/`localhost`, which is how local labs and localhost API
targets silently escape capture; ZIMREAPER passes `--proxy-bypass-list=<-loopback>` so they do not.

Verified: with `mitmdump -p 8085 -w flows.mitm`, a headless launch and the packaged GUI both
captured `http://127.0.0.1:4399/login` and `https://example.com` through the proxy, with the page
rendering normally under TLS interception.

This works for both topologies — the GUI window and `zimreaper mcp --launch`.

## 2. Put the scope in the policy file

The scope contract stops being a paragraph in your notes and becomes something the tool enforces:

```json
{
  "mode": "strict",
  "origins": {
    "*.target.com":     { "tier": "transact", "allowEval": true, "allowUploads": true },
    "api.target.com":   { "tier": "transact" },
    "*.out-of-scope.tld": { "tier": "read" }
  }
}
```

`~/.zimreaper/policy.json`. With `strict`, anything you have not listed is read-only — the agent
physically cannot submit forms or click destructive buttons on a host you forgot to scope. Actions
matching `pay`, `transfer`, `delete`, `authorize` and friends pause for human approval regardless of
tier, and `zimreaper audit verify` proves the log was not edited.

## 3. Recon the way an agent is good at

```
browser_navigate  https://target.com
browser_snapshot                  → what the app thinks is interactive
browser_network   op=log          → every XHR/fetch the page fired, with headers and bodies
browser_network   op=body id=…    → the JSON behind a UI table, unminified by the app itself
browser_extract   row=".user-row" fields={id,email,role}
browser_diff                      → what changed after an action, without re-reading the page
browser_screenshot annotated=true → evidence with numbered marks for the report
```

The network log is usually where the finding is: hidden API endpoints, `?role=admin` in a request
the UI never shows, internal ids in a response the frontend ignores. `browser_network op=route` and
`op=replay` let the agent rewrite and resend a captured request — the agent-side equivalent of
"Send to Repeater", without leaving the browser.

## 4. Authz and IDOR testing with forked sessions

`browser_fork_session` clones the authenticated tab into independent tabs that share the login
state. That is the primitive behind parallel authorization testing: drive the same object from two
identities and diff the responses.

```
1. log in as user A, open /orders/1001
2. browser_fork_session  → tabs A1, A2 (same cookies, independent navigation)
3. in one tab, tamper the id to 1002; in the other, stay on 1001
4. browser_diff + browser_network op=body  → is 1002's payload returned to A?
5. screenshot both, then replay the trace as proof
```

Because input is real, this exercises the same server paths a human would, including the SPA's
client-side guards — which is exactly where broken access control hides.

## 5. Turn a proof into a regression test

The expensive part of a bounty report is reproducing it for a triager. Record once:

```bash
~/Applications/ZimReaper-0.1.0-x86_64.AppImage replay idor-1002.jsonl --url https://target.com/orders/1001
```

The player re-binds refs by role and accessible name, so it still hits the right element after the
app's UI changes; if the page state no longer matches what was recorded, it reports a divergence and
refuses to click blind. Exit code 1 on divergence, so it drops into CI and into the report as a
one-command repro.

## 6. Let your agent hunt, keep your hands on the wheel

Wire Claude, Hermes or Codex to it (see the README) and the split is: the agent does the tedious
navigation, the table extraction, the "click every link and tell me which ones 500", the
hundred-request crawl; you get the HUD, the kill switch, and the audit log. `browser_ask_human`
exists so the agent can hand you the browser when it hits a login, a CAPTCHA, or something that
looks like a finding.

---

## What this is not

- **Not a scanner.** No payload lists, no fuzzing engine, no automatic CVE matching. It is the
  browser half of your workflow, driven by an agent.
- **Not a replacement for your proxy.** mitmproxy/Burp remains the source of truth for raw traffic;
  ZIMREAPER is what generates it, authenticated and at speed.
- **Not stealth tooling.** No fingerprint spoofing, no anti-bot evasion. Real input events are used
  because they exercise real code paths, not to defeat detection.
- **`browser_network op=route|replay`** is implemented but less battle-tested than `op=log|body`;
  verify on your target before you build a report around request rewriting.

## Checklist before you hunt

```bash
# 1. proxy running and reachable
curl -x http://127.0.0.1:8080 -s -o /dev/null -w "%{http_code}\n" https://target.com

# 2. browser routing through it
ZIMREAPER_PROXY=http://127.0.0.1:8080 ZIMREAPER_INSECURE=1 \
  ~/Applications/ZimReaper-0.1.0-x86_64.AppImage

# 3. scope enforced
cat ~/.zimreaper/policy.json

# 4. session alive, agent attached
~/Applications/ZimReaper-0.1.0-x86_64.AppImage info
```

Log in **yourself** in the window — that is the point of attach mode: the session is yours, the
agent drives it, and you can take the mouse back at any moment.
