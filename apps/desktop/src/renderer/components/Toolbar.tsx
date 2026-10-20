import { useEffect, useRef, useState } from "react";
import type { TabViewState } from "../../shared/ipc.js";
import type { AgentState } from "../hooks/use-desktop.js";
import { AlertIcon, ArrowLeftIcon, ArrowRightIcon, GlobeIcon, HandIcon, LockIcon, PanelIcon, PlayIcon, ReloadIcon, ShieldIcon, StopIcon } from "./icons.js";

interface Props {
  tab?: TabViewState;
  agentState: AgentState;
  agentDetail?: string;
  focusUrlSignal: number;
  panelOpen: boolean;
  disabled: boolean;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onGoto(url: string): void;
  onTakeOver(): void;
  onKill(): void;
  onTogglePanel(): void;
}

function security(url: string): { secure: boolean; label: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return { secure: true, label: "Secure connection" };
    if (parsed.protocol === "http:") return { secure: false, label: "Not secure" };
    return { secure: false, label: parsed.protocol.replace(":", "") };
  } catch {
    return { secure: false, label: "New tab" };
  }
}

export function Toolbar(props: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(props.tab?.url ?? "");
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setValue(props.tab?.url ?? "");
  }, [props.tab?.url, focused]);

  useEffect(() => {
    if (props.focusUrlSignal > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [props.focusUrlSignal]);

  const state = security(props.tab?.url ?? "");
  const submit = () => {
    if (!value.trim()) return;
    props.onGoto(value);
    inputRef.current?.blur();
  };
  const takeoverLabel = props.agentState === "paused" ? "Resume" : "Take over";

  return (
    <div className="toolbar">
      <div className="nav-buttons">
        <button className="icon-button" onClick={props.onBack} disabled={props.disabled || !props.tab?.canGoBack} aria-label="Back" title="Back (Alt+Left)">
          <ArrowLeftIcon />
        </button>
        <button className="icon-button" onClick={props.onForward} disabled={props.disabled || !props.tab?.canGoForward} aria-label="Forward" title="Forward (Alt+Right)">
          <ArrowRightIcon />
        </button>
        <button className="icon-button" onClick={props.onReload} disabled={props.disabled} aria-label="Reload" title="Reload (Cmd/Ctrl+R)">
          <ReloadIcon />
        </button>
      </div>

      <div className={`urlbar ${focused ? "urlbar-focused" : ""}`}>
        <span className={`security ${state.secure ? "security-secure" : ""}`} title={state.label}>
          {state.secure ? <LockIcon width={13} height={13} /> : <GlobeIcon width={13} height={13} />}
        </span>
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          aria-label="Address and search"
          placeholder="Search or enter address"
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => {
            setFocused(true);
            event.currentTarget.select();
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
            if (event.key === "Escape") {
              setValue(props.tab?.url ?? "");
              event.currentTarget.blur();
            }
          }}
        />
        {props.tab?.loading && <span className="url-progress" aria-label="Loading" />}
        <span className="security-label">{state.label}</span>
      </div>

      <div className={`agent-pill agent-${props.agentState}`} title={props.agentDetail ?? props.agentState}>
        <span className="agent-dot" />
        <span className="agent-label">{props.agentState}</span>
        {props.agentDetail && <span className="agent-detail">{props.agentDetail}</span>}
      </div>

      <button className="text-button takeover" onClick={props.onTakeOver} disabled={props.disabled}>
        {props.agentState === "paused" ? <PlayIcon width={13} height={13} /> : <HandIcon width={13} height={13} />}
        {takeoverLabel}
      </button>

      <button className="kill-button" onClick={props.onKill} title="Kill switch (Esc)" aria-label="Kill switch">
        <StopIcon width={12} height={12} />
        <span>Kill</span>
      </button>

      <button className={`icon-button panel-button ${props.panelOpen ? "active" : ""}`} onClick={props.onTogglePanel} aria-label="Toggle agent panel" title="Toggle agent panel">
        <PanelIcon />
      </button>
    </div>
  );
}

export function StatusRail({ warning }: { warning?: string }) {
  if (!warning) return null;
  return (
    <div className="status-rail">
      <AlertIcon width={13} height={13} />
      <span>{warning}</span>
      <ShieldIcon width={12} height={12} />
    </div>
  );
}
