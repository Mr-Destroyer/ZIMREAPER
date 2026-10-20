import { useCallback, useEffect, useRef, useState } from "react";
import { Hud } from "./components/Hud.js";
import { TabStrip } from "./components/TabStrip.js";
import { StatusRail, Toolbar } from "./components/Toolbar.js";
import { useDesktop } from "./hooks/use-desktop.js";

const TOOLBAR_HEIGHT = 104;

export function App() {
  const state = useDesktop();
  const bridge = state.bridge;
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(336);
  const contentRef = useRef<HTMLDivElement>(null);

  const syncBounds = useCallback(() => {
    const node = contentRef.current;
    if (!node || !bridge) return;
    const rect = node.getBoundingClientRect();
    void bridge.tabs.setContentBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }).catch(() => undefined);
  }, [bridge]);

  useEffect(() => {
    syncBounds();
    const node = contentRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => syncBounds());
    observer.observe(node);
    window.addEventListener("resize", syncBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [syncBounds, panelOpen, panelWidth]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void bridge?.agent.kill().catch(() => undefined);
        return;
      }
      const mod = navigator.platform.includes("Mac") ? event.metaKey : event.ctrlKey;
      if (!mod) return;
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        void bridge?.tabs.create().catch(() => undefined);
      }
      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        if (state.activeTabId) void bridge?.tabs.close(state.activeTabId).catch(() => undefined);
      }
      if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        const input = document.querySelector<HTMLInputElement>(".urlbar input");
        input?.focus();
        input?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge, state.activeTabId]);

  const activeTab = state.snapshot.tabs.find((tab) => tab.tabId === state.activeTabId);
  const disabled = !bridge;

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    const move = (moveEvent: PointerEvent) => {
      setPanelWidth(Math.max(280, Math.min(560, startWidth + (startX - moveEvent.clientX))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="app-shell">
      <TabStrip
        tabs={state.snapshot.tabs}
        activeTabId={state.activeTabId}
        disabled={disabled}
        onActivate={(tabId) => void bridge?.tabs.activate(tabId).catch(() => undefined)}
        onClose={(tabId) => void bridge?.tabs.close(tabId).catch(() => undefined)}
        onNew={() => void bridge?.tabs.create().catch(() => undefined)}
        onReorder={(ids) => void bridge?.tabs.reorder(ids).catch(() => undefined)}
      />
      <Toolbar
        tab={activeTab}
        agentState={state.agentState}
        agentDetail={state.agentDetail}
        focusUrlSignal={state.focusUrlSignal}
        panelOpen={panelOpen}
        disabled={disabled}
        onBack={() => void bridge?.nav.back().catch(() => undefined)}
        onForward={() => void bridge?.nav.forward().catch(() => undefined)}
        onReload={() => void bridge?.nav.reload().catch(() => undefined)}
        onGoto={(url) => void bridge?.nav.goto(url).catch(() => undefined)}
        onTakeOver={() => void bridge?.agent.resume().catch(() => undefined)}
        onKill={() => void bridge?.agent.kill().catch(() => undefined)}
        onTogglePanel={() => setPanelOpen((open) => !open)}
      />
      <StatusRail warning={state.controlWarning} />

      <main className={`workspace ${panelOpen ? "with-panel" : ""}`}>
        <div className="content-host" ref={contentRef}>
          <div className="content-placeholder">
            <div className="placeholder-mark">Z</div>
            <div className="placeholder-copy">
              <strong>{activeTab?.title || "Loading page"}</strong>
              <span>{activeTab?.url || "Waiting for the browser view"}</span>
            </div>
          </div>
        </div>
        {panelOpen && (
          <>
            <div className="panel-resizer" onPointerDown={startResize} role="separator" aria-orientation="vertical" />
            <div className="panel-slot" style={{ width: panelWidth }}>
              <Hud
                info={state.info}
                lines={state.lines}
                approvals={state.approvals}
                ghost={state.ghost}
                diff={state.diff}
                onResolve={(id, approved) => void bridge?.hud.resolveApproval(id, approved).catch(() => undefined)}
                onClose={() => setPanelOpen(false)}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
