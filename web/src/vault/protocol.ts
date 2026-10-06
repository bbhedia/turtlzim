// What the page and the Worker that runs the core say to each other, and what the core says.

/** Where the core keeps its databases when it is told to keep them: a directory of the origin-private file system. */
export interface Persistence {
  directory: string;
}

/** The page's messages to the Worker. */
export type WorkerRequest =
  /** Load the core and start it (with persistence, if given). Answered by `booted` or `error`. */
  | { op: "boot"; persistence: Persistence | null }
  /** Hand the core a message (a JSON string: `["<id>", "<command>", args...]`). */
  | { op: "send"; message: string }
  /** Stop the core. Answered by `stopped`. */
  | { op: "stop" };

/** The Worker's messages to the page. */
export type WorkerReply =
  | { type: "booted" }
  | { type: "stopped" }
  /** Everything the core sends: `channel` says whether it is a response or an event. */
  | { type: "message"; channel: string; message: string }
  /** Something went wrong in answer to `op`. */
  | { type: "error"; op: string; error: string };

/** The core's answer to a request. `e` is 0 when it worked, and then `d` is the result; otherwise `d` says what went wrong. */
export interface CoreResponse {
  id: string;
  e: number;
  d: unknown;
}

/** Something that happened in the core that nobody asked about (`user:login`, `profile:loaded`, ...). */
export interface CoreEvent {
  e: string;
  d: unknown;
}

/** The channel the core's responses go out on. (Events go out on any other.) */
export const RESPONSE_CHANNEL = "inproc://turtl-req-core-out";
