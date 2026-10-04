export type RuntimePaths = {
  launcherPath: string;
};

export type WiringEntry = {
  hookEvent: string;
  handler: string;
  command: string;
  args: string[];
  timeoutSeconds: number;
  failClosed?: boolean;
  matcher?: string;
  loopLimit?: number;
};

/**
 * How a wiring document is written.
 *
 * - `replace` — the file is ours alone, written whole.
 * - `merge` — ours are entries inside per-event lists the operator and other tools share.
 * - `named-merge` — the file is a map of named hook sets and ours is one whole set under a name of its own;
 *   every other set is left exactly as it was ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
export type ProviderWiring = {
  target: string;
  strategy: "replace" | "merge" | "named-merge";
  entries: WiringEntry[];
};
