import type { DesktopBridge } from "../shared/ipc.js";

declare global {
  interface Window {
    zimreaper?: DesktopBridge;
  }
}

export {};
