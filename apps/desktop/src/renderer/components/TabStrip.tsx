import { useState, type DragEvent } from "react";
import type { TabViewState } from "../../shared/ipc.js";
import { PlusIcon, XIcon } from "./icons.js";

interface Props {
  tabs: TabViewState[];
  activeTabId?: string;
  disabled: boolean;
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
  onNew(): void;
  onReorder(tabIds: string[]): void;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "new tab";
  } catch {
    return url || "new tab";
  }
}

function Favicon({ tab }: { tab: TabViewState }) {
  const [failed, setFailed] = useState(false);
  if (tab.favicon && !failed) {
    return <img className="favicon" src={tab.favicon} alt="" onError={() => setFailed(true)} />;
  }
  return (
    <span className="favicon favicon-fallback" aria-hidden>
      {host(tab.url).charAt(0).toUpperCase()}
    </span>
  );
}

export function TabStrip({ tabs, activeTabId, disabled, onActivate, onClose, onNew, onReorder }: Props) {
  const [dragging, setDragging] = useState<string>();

  const dragStart = (event: DragEvent, tabId: string) => {
    setDragging(tabId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tabId);
  };
  const drop = (event: DragEvent, targetId: string) => {
    event.preventDefault();
    const sourceId = dragging ?? event.dataTransfer.getData("text/plain");
    setDragging(undefined);
    if (!sourceId || sourceId === targetId) return;
    const ids = tabs.map((tab) => tab.tabId);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    onReorder(ids);
  };

  return (
    <div className="tabstrip">
      <div className="tabstrip-drag" />
      <div className="tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab) => (
          <div
            key={tab.tabId}
            className={`tab ${tab.tabId === activeTabId ? "tab-active" : ""} ${tab.loading ? "tab-loading" : ""}`}
            role="tab"
            aria-selected={tab.tabId === activeTabId}
            tabIndex={0}
            draggable
            onDragStart={(event) => dragStart(event, tab.tabId)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => drop(event, tab.tabId)}
            onMouseDown={(event) => {
              if (event.button === 1) onClose(tab.tabId);
              else onActivate(tab.tabId);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onActivate(tab.tabId);
            }}
            title={`${tab.title} — ${tab.url}`}
          >
            <Favicon tab={tab} />
            <span className="tab-title">{tab.title || host(tab.url)}</span>
            <button
              className="tab-close"
              aria-label={`Close ${tab.title}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.tabId);
              }}
            >
              <XIcon width={12} height={12} />
            </button>
          </div>
        ))}
        <button className="new-tab" onClick={onNew} disabled={disabled} aria-label="New tab" title="New tab (Cmd/Ctrl+T)">
          <PlusIcon />
        </button>
      </div>
    </div>
  );
}
