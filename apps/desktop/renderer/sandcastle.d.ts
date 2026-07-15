import type { SandcastleBridge } from "../preload/bridge.js";

declare global {
  interface Window {
    readonly sandcastle: SandcastleBridge;
  }
}

export {};
