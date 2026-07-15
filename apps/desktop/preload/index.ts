import { contextBridge, ipcRenderer } from "electron";
import { createSandcastleBridge } from "./bridge.js";

contextBridge.exposeInMainWorld(
  "sandcastle",
  createSandcastleBridge((channel, payload) =>
    ipcRenderer.invoke(channel, payload),
  ),
);
