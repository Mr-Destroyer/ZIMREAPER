import { useEffect, useMemo, useRef, useState } from "react";
import type { Approval, HudLine } from "../hooks/use-desktop.js";
import type { AppInfo, GhostCursor } from "../../shared/ipc.js";
import { AlertIcon, ChevronIcon, CursorIcon, ShieldIcon, XIcon } from "./icons.js";

interface Props {
  info?: AppInfo;
  lines: HudLine[];
  approvals: Approval[];
  ghost?: GhostCursor;
  diff?: string;
  onResolve(id: string, approved: boolean): void;
  onClose(): void;
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(Math.max(0, expiresAt - Date.now()));
  useEffect(() => {
    const timer = setInterval(() => setRemaining(Math.max(0, expiresAt - Date.now())), 250);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return <span className={remaining < 20_000 ? "countdown countdown-urgent" : "countdown"}>{Math.ceil(remaining / 1000)}s</span>;
}

function GhostMap({ cursor }: { cursor: GhostCursor }) {
  return (
    <div className="ghostmap" aria-label="Agent cursor position">
      <div className="ghostmap-grid" />
      <div className="ghost-dot" style={{ left: `${Math.max(2, Math.min(98, cursor.x / 12.8))}%`, top: `${Math.max(2, Math.min(98, cursor.y / 8))}%` }}>
        <CursorIcon width={12} height={12} />
      </div>
      <div className="ghostmap-meta">
        <span>x {Math.round(cursor.x)}</span>
        <span>y {Math.round(cursor.y)}</span>
        {cursor.label && <span className="ghost-label">{cursor.label}</span>}
      </div>
    </div>
  );
}

export function Hud({ info, lines, approvals, ghost, diff, onResolve, onClose }: Props) {
  const [filter, setFilter] = useState<"all" | "net" | "console" | "actions">("all");
  const feedRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    if (filter === "all") return lines;
    if (filter === "net") return lines.filter((line) => /net|download/i.test(line.label));
    if (filter === "console") return lines.filter((line) => /console|error|warn/i.test(line.label));
    return lines.filter((line) => /action|approval|audit|agent/i.test(line.label));
  }, [filter, lines]);

  return (
    <aside className="hud" aria-label="Agent control plane">
      <header className="hud-header">
        <div>
          <div className="hud-eyebrow">Control plane</div>
          <div className="hud-title">Agent activity</div>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close panel">
          <XIcon />
        </button>
      </header>

      <div className="hud-connection">
        <span className={`connection-dot ${info?.controlAvailable ? "online" : "offline"}`} />
        {info?.controlAvailable ? (
          <span>ws://127.0.0.1:{info.port}</span>
        ) : (
          <span>local browsing · control plane offline</span>
        )}
        <span className="hud-version">v{info?.version ?? "0.1.0"}</span>
      </div>

      {approvals.length > 0 && (
        <section className="approval-stack" aria-label="Pending approvals">
          {approvals.map((approval) => (
            <article className="approval-card" key={approval.id}>
              <div className="approval-top">
                <span className="approval-icon"><ShieldIcon width={14} height={14} /></span>
                <span className="approval-kind">{approval.actionKind}</span>
                <Countdown expiresAt={approval.expiresAt} />
              </div>
              <p className="approval-reason">{approval.reason}</p>
              {approval.screenshotPath && <div className="approval-artifact">{approval.screenshotPath}</div>}
              <div className="approval-actions">
                <button className="approve" onClick={() => onResolve(approval.id, true)}>Approve</button>
                <button className="deny" onClick={() => onResolve(approval.id, false)}>Deny</button>
              </div>
            </article>
          ))}
        </section>
      )}

      <section className="hud-section">
        <div className="section-heading">
          <span>Agent cursor</span>
          <span className="section-hint">live</span>
        </div>
        {ghost ? <GhostMap cursor={ghost} /> : <div className="ghostmap ghostmap-idle"><span>No agent input yet</span></div>}
      </section>

      {diff && (
        <section className="hud-section">
          <div className="section-heading">
            <span>What changed</span>
            <ChevronIcon width={12} height={12} />
          </div>
          <p className="diff-line">{diff}</p>
        </section>
      )}

      <section className="hud-section hud-feed-section">
        <div className="section-heading">
          <span>Event stream</span>
          <span className="section-hint">{lines.length}</span>
        </div>
        <div className="filter-row" role="tablist" aria-label="Event filter">
          {(["all", "actions", "net", "console"] as const).map((value) => (
            <button key={value} className={filter === value ? "filter active" : "filter"} onClick={() => setFilter(value)}>
              {value}
            </button>
          ))}
        </div>
        <div className="event-feed" ref={feedRef} role="log" aria-live="polite">
          {visible.length === 0 && (
            <div className="empty-feed">
              <AlertIcon width={16} height={16} />
              <span>Waiting for the agent. Events appear here as actions run.</span>
            </div>
          )}
          {visible.map((line) => (
            <div className={`event-row tone-${line.tone}`} key={`${line.id}-${line.ts}`}>
              <span className="event-time">{time(line.ts)}</span>
              <span className="event-label">{line.label}</span>
              <span className="event-detail" title={line.detail}>{line.detail}</span>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}
