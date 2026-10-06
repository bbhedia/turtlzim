// A dedicated Worker that runs the core, so that nothing it does (key derivation takes a second or so,
// opening a notebook decrypts every page) can hold up the page, and because the origin-private file
// system's fast synchronous files, which the databases are kept in, exist only in dedicated Workers.
// The page's side of the conversation is `WorkerTransport` in core-client.ts; the messages are in
// protocol.ts.
import sodium from "libsodium-wrappers-sumo";
import { bootCore, sendToCore, stopTheCore } from "./core-boot";
import type { WorkerReply, WorkerRequest } from "./protocol";

interface WorkerScope {
  postMessage(message: WorkerReply): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = async (event) => {
  const request = event.data;
  try {
    switch (request.op) {
      case "boot":
        await bootCore({
          sodium,
          persistence: request.persistence,
          onMessage: (channel, message) => scope.postMessage({ type: "message", channel, message }),
        });
        scope.postMessage({ type: "booted" });
        break;
      case "send":
        sendToCore(request.message);
        break;
      case "stop":
        stopTheCore();
        scope.postMessage({ type: "stopped" });
        break;
    }
  } catch (error) {
    scope.postMessage({ type: "error", op: request.op, error: error instanceof Error ? error.message : String(error) });
  }
};
