import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Event } from "@zimreaper/protocol";
import type { AppInfo, DesktopBridge, GhostCursor, HudEvent, TabSnapshot } from "../../shared/ipc.js";

export type AgentState = "idle" | "working" | "blocked" | "paused";

export interface Approval {
  id: string;
  actionKind: string;
  reason: string;
  screenshotPath?: string;
  expiresAt: number;
}

export interface HudLine {
  id: string;
  ts: number;
  tone: "neutral" | "good" | "warn" | "bad" | "accent";
  label: string;
  detail: string;
}

const EMPTY_SNAPSHOT: TabSnapshot = { tabs: [] };

function stamp(): number {
  return Date.now();
}

function lineFor(event: HudEvent): HudLine | undefined {
  if (event.type !== "protocol") return undefined;
  const e: Event = event.event;
  switch (e.kind) {
    case "action.started":
      return { id: `a-${e.id}`, ts: stamp(), tone: "accent", label: e.actionKind, detail: "started" };
    case "action.finished":
      return { id: `a-${e.id}`, ts: stamp(), tone: e.ok ? "good" : "bad", label: e.actionKind, detail: `${e.ok ? "ok" : "failed"} · ${e.ms}ms` };
    case "nav.committed":
      return { id: `n-${stamp()}-${e.tabId}`, ts: stamp(), tone: "neutral", label: "nav", detail: e.url };
    case "nav.loaded":
      return { id: `n-${stamp()}-${e.tabId}`, ts: stamp(), tone: "neutral", label: "loaded", detail: e.url };
    case "console.message":
      return { id: `c-${stamp()}`, ts: stamp(), tone: e.level === "error" ? "bad" : "neutral", label: e.level, detail: e.text.slice(0, 160) };
    case "net.request":
      return { id: `r-${e.entry.requestId}`, ts: stamp(), tone: "neutral", label: e.entry.method, detail: e.entry.url };
    case "net.response":
      return { id: `r-${e.entry.requestId}`, ts: stamp(), tone: e.entry.status && e.entry.status >= 400 ? "warn" : "good", label: String(e.entry.status ?? "net"), detail: e.entry.url };
    case "net.failed":
      return { id: `r-${e.entry.requestId}`, ts: stamp(), tone: "bad", label: "net failed", detail: e.entry.error ?? e.entry.url };
    case "dialog.opened":
      return { id: `d-${stamp()}`, ts: stamp(), tone: "warn", label: `dialog · ${e.type}`, detail: e.message };
    case "download.started":
      return { id: `dl-${stamp()}`, ts: stamp(), tone: "accent", label: "download", detail: e.filename };
    case "download.finished":
      return { id: `dl-${stamp()}`, ts: stamp(), tone: e.state === "completed" ? "good" : "warn", label: "download", detail: `${e.state} · ${e.path}` };
    case "human.input":
      return { id: `h-${stamp()}`, ts: stamp(), tone: "warn", label: "human input", detail: e.inputKind };
    case "human.released":
      return { id: `h-${stamp()}`, ts: stamp(), tone: "good", label: "human released", detail: e.tabId };
    case "agent.status":
      return { id: `s-${stamp()}`, ts: stamp(), tone: e.state === "paused" ? "warn" : e.state === "blocked" ? "bad" : "accent", label: "agent", detail: e.detail ?? e.state };
    case "approval.requested":
      return { id: `p-${e.id}`, ts: stamp(), tone: "warn", label: "approval", detail: e.reason };
    case "approval.resolved":
      return { id: `p-${e.id}`, ts: stamp(), tone: e.approved ? "good" : "bad", label: "approval", detail: e.approved ? "approved" : "denied" };
    case "audit.entry":
      return { id: `u-${e.entry.seq}`, ts: stamp(), tone: e.entry.outcome === "block" ? "bad" : "neutral", label: "audit", detail: `${e.entry.kind} · ${e.entry.outcome}` };
    case "tab.created":
      return { id: `t-${stamp()}`, ts: stamp(), tone: "neutral", label: "tab created", detail: e.tab.url };
    case "tab.closed":
      return { id: `t-${stamp()}`, ts: stamp(), tone: "neutral", label: "tab closed", detail: e.tabId };
    case "tab.activated":
      return { id: `t-${stamp()}`, ts: stamp(), tone: "neutral", label: "tab active", detail: e.tabId };
    case "tab.updated":
      return undefined;
    default:
      return undefined;
  }
}

export interface DesktopState {
  bridge?: DesktopBridge;
  info?: AppInfo;
  snapshot: TabSnapshot;
  activeTabId?: string;
  agentState: AgentState;
  agentDetail?: string;
  lines: HudLine[];
  approvals: Approval[];
  ghost?: GhostCursor;
  diff?: string;
  controlWarning?: string;
  focusUrlSignal: number;
}

export function useDesktop(): DesktopState {
  const bridge = typeof window !== "undefined" ? window.zimreaper : undefined;
  const [info, setInfo] = useState<AppInfo>();
  const [snapshot, setSnapshot] = useState<TabSnapshot>(EMPTY_SNAPSHOT);
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [agentDetail, setAgentDetail] = useState<string>();
  const [lines, setLines] = useState<HudLine[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [ghost, setGhost] = useState<GhostCursor>();
  const [diff, setDiff] = useState<string>();
  const [controlWarning, setControlWarning] = useState<string>();
  const [focusUrlSignal, setFocusUrlSignal] = useState(0);
  const seen = useRef(new Set<string>());

  const pushLine = useCallback((line: HudLine) => {
    setLines((current) => {
      const next = [line, ...current];
      return next.slice(0, 250);
    });
  }, []);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.app.info().then((next) => {
      if (!cancelled) setInfo(next);
    }).catch(() => undefined);
    void bridge.tabs.list().then((next) => {
      if (!cancelled) setSnapshot(next);
    }).catch(() => undefined);

    const unsubscribe = bridge.hud.subscribe((event) => {
      switch (event.type) {
        case "protocol": {
          const e = event.event;
          if (e.kind === "agent.status") {
            setAgentState(e.state);
            setAgentDetail(e.detail);
          }
          if (e.kind === "approval.requested") {
            setAgentState("blocked");
            setApprovals((current) => {
              if (current.some((approval) => approval.id === e.id)) return current;
              return [...current, { id: e.id, actionKind: e.actionKind, reason: e.reason, screenshotPath: e.screenshotPath, expiresAt: Date.now() + 120_000 }];
            });
          }
          if (e.kind === "approval.resolved") {
            setApprovals((current) => current.filter((approval) => approval.id !== e.id));
          }
          if (e.kind === "tab.created" || e.kind === "tab.closed" || e.kind === "tab.activated" || e.kind === "tab.updated") {
            void bridge.tabs.list().then(setSnapshot).catch(() => undefined);
          }
          const line = lineFor(event);
          if (line && !seen.current.has(`${line.id}:${line.detail}`)) {
            seen.current.add(`${line.id}:${line.detail}`);
            pushLine(line);
          }
          break;
        }
        case "tab.snapshot":
          setSnapshot(event.snapshot);
          break;
        case "agent.status":
          setAgentState(event.state);
          setAgentDetail(event.detail);
          break;
        case "approval.requested":
          setAgentState("blocked");
          setApprovals((current) => current.some((a) => a.id === event.id) ? current : [...current, { id: event.id, actionKind: event.actionKind, reason: event.reason, screenshotPath: event.screenshotPath, expiresAt: event.expiresAt ?? Date.now() + 120_000 }]);
          break;
        case "approval.resolved":
          setApprovals((current) => current.filter((approval) => approval.id !== event.id));
          break;
        case "ghost":
          setGhost(event.cursor);
          break;
        case "page.diff":
          setDiff(event.text);
          break;
        case "control.unavailable":
          setControlWarning(event.message);
          break;
        case "focus-url":
          setFocusUrlSignal((value) => value + 1);
          break;
        case "human.released":
          setAgentState("idle");
          setAgentDetail("human released control");
          break;
        case "nav.state":
          void bridge.tabs.list().then(setSnapshot).catch(() => undefined);
          break;
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge, pushLine]);

  useEffect(() => {
    if (!bridge) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setApprovals((current) => current.filter((approval) => approval.expiresAt > now));
    }, 1000);
    return () => clearInterval(timer);
  }, [bridge]);

  const activeTabId = snapshot.activeTabId;
  const memo = useMemo(() => ({ bridge, info, snapshot, activeTabId, agentState, agentDetail, lines, approvals, ghost, diff, controlWarning, focusUrlSignal }), [bridge, info, snapshot, activeTabId, agentState, agentDetail, lines, approvals, ghost, diff, controlWarning, focusUrlSignal]);
  return memo;
}
