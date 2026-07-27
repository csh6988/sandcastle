import { contextBridge, ipcRenderer } from "electron";
import {
  createSandcastleBridge,
  RUNTIME_EVENT_PORT_CHANNEL,
  type RuntimeEventPort,
} from "./bridge.js";

contextBridge.exposeInMainWorld(
  "sandcastle",
  createSandcastleBridge(
    (channel, payload) => ipcRenderer.invoke(channel, payload),
    {
      onPort(listener) {
        ipcRenderer.on(RUNTIME_EVENT_PORT_CHANNEL, (event, message) => {
          const port = event.ports[0];
          const streamRequestId =
            typeof message === "object" &&
            message !== null &&
            "streamRequestId" in message &&
            typeof message.streamRequestId === "string"
              ? message.streamRequestId
              : null;
          if (!port || !streamRequestId) {
            return;
          }
          listener({
            streamRequestId,
            port: port as unknown as RuntimeEventPort,
          });
        });
      },
    },
  ),
);
