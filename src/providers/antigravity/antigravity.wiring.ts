import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProviderWiring, RuntimePaths, WiringEntry } from "../../contracts/index.ts";
import { ANTIGRAVITY_EVENT_ENV } from "./antigravity.inbound.ts";

/**
 * The top-level key our hooks live under.
 *
 * why a key of our own: agy's hooks file is a map of named hook sets, and other tools already keep theirs there —
 * the Orca hook (`orca-status`) on the machine these payloads were captured from. Owning one name is what lets
 * the merge replace ours wholesale and leave every other set byte-for-byte alone.
 */
export const ANTIGRAVITY_HOOK_SET = "tlc-harness";

type EntrySpec = { hookEvent: string; handler: string; timeoutSeconds: number; matcher?: string };

// why these four: the events whose payload and response were observed. PostInvocation is left out — it is
// byte-identical to PreInvocation and has nothing to map to ([/decisions/ad-146.md](/decisions/ad-146.md)).
const ENTRY_SPECS: readonly EntrySpec[] = [
  { hookEvent: "PreInvocation", handler: "prompt-submit", timeoutSeconds: 5 },
  { hookEvent: "PreToolUse", handler: "tool-before", timeoutSeconds: 10, matcher: "*" },
  { hookEvent: "PostToolUse", handler: "tool-after", timeoutSeconds: 10, matcher: "*" },
  { hookEvent: "Stop", handler: "stop", timeoutSeconds: 120 },
];

export function antigravityGlobalHooksPath(): string {
  return join(homedir(), ".gemini", "config", "hooks.json");
}

export function antigravityWorkspaceHooksPath(projectDir: string): string {
  return join(projectDir, ".agents", "hooks.json");
}

/**
 * why the workspace file too: agy loads `<workspace>/.agents/hooks.json` without asking, even in an untrusted
 * directory — so an agent that can write it can unregister this harness for the next session, exactly as it
 * could by writing the global file.
 */
export function antigravityWiringTargets(projectDir?: string): string[] {
  const global = antigravityGlobalHooksPath();
  return projectDir === undefined ? [global] : [global, antigravityWorkspaceHooksPath(projectDir)];
}

export function antigravityWiring(runtime: RuntimePaths): ProviderWiring {
  const entries: WiringEntry[] = ENTRY_SPECS.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command: "node",
    args: [runtime.launcherPath, spec.handler],
    timeoutSeconds: spec.timeoutSeconds,
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
  }));
  return { target: antigravityGlobalHooksPath(), strategy: "named-merge", entries };
}

const SHELL_SAFE = /^[A-Za-z0-9_./=:@%+-]+$/;

// why single quotes: the command runs through a shell (the leading assignment depends on it), and inside single
// quotes nothing expands — a path with a space, a `$` or a quote stays one literal word.
function shellWord(token: string): string {
  return SHELL_SAFE.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`;
}

function commandFor(entry: WiringEntry): string {
  const words = [entry.command, ...entry.args].map(shellWord);
  return [`${ANTIGRAVITY_EVENT_ENV}=${shellWord(entry.hookEvent)}`, ...words].join(" ");
}

function renderAntigravityHookSet(entries: readonly WiringEntry[]): Record<string, unknown[]> {
  const set: Record<string, unknown[]> = {};
  for (const entry of entries) {
    const hook = { type: "command", command: commandFor(entry), timeout: entry.timeoutSeconds };
    const row = entry.matcher === undefined ? hook : { matcher: entry.matcher, hooks: [hook] };
    set[entry.hookEvent] = [...(set[entry.hookEvent] ?? []), row];
  }
  return set;
}

export type AntigravityMerge = { ok: true; text: string; changed: boolean } | { ok: false; error: string };

type Parsed = { ok: true; document: Record<string, unknown> } | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseDocument(text: string | null): Parsed {
  if (text === null || text.trim() === "") {
    return { ok: true, document: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const document = asRecord(parsed);
  return document ? { ok: true, document } : { ok: false, error: "hooks.json root is not a JSON object" };
}

function render(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * invariant: only `tlc-harness` is ever written; every other top-level key keeps its value and its position. A
 * file that does not parse is refused rather than replaced — it is the operator's, and it holds other tools' hooks.
 */
export function mergeAntigravityHooks(
  existingText: string | null,
  entries: readonly WiringEntry[],
): AntigravityMerge {
  const parsed = parseDocument(existingText);
  if (!parsed.ok) {
    return parsed;
  }
  const current = asRecord(parsed.document[ANTIGRAVITY_HOOK_SET]);
  // why: `enabled` is agy's per-set switch, and turning ours off is the operator's call — an update that flipped
  // it back on would undo a decision nobody asked it to revisit.
  const desired: Record<string, unknown> =
    current !== undefined && "enabled" in current
      ? { enabled: current.enabled, ...renderAntigravityHookSet(entries) }
      : renderAntigravityHookSet(entries);
  const changed = !isDeepStrictEqual(current, desired);
  return { ok: true, text: render({ ...parsed.document, [ANTIGRAVITY_HOOK_SET]: desired }), changed };
}

export function applyAntigravityWiring(path: string, entries: readonly WiringEntry[]): AntigravityMerge {
  const existingText = existsSync(path) ? readFileSync(path, "utf8") : null;
  const result = mergeAntigravityHooks(existingText, entries);
  if (result.ok && result.changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, result.text, "utf8");
  }
  return result;
}

export type AntigravityUnmerge =
  | { kind: "absent" }
  | { kind: "unparsed" }
  | { kind: "unchanged" }
  | { kind: "empty" }
  | { kind: "rewritten"; text: string };

/** The inverse of `mergeAntigravityHooks`: our set leaves, and nothing else moves. */
export function unmergeAntigravityHooks(existingText: string | null): AntigravityUnmerge {
  if (existingText === null || existingText.trim() === "") {
    return { kind: "absent" };
  }
  const parsed = parseDocument(existingText);
  if (!parsed.ok) {
    return { kind: "unparsed" };
  }
  if (!(ANTIGRAVITY_HOOK_SET in parsed.document)) {
    return { kind: "unchanged" };
  }
  const { [ANTIGRAVITY_HOOK_SET]: _ours, ...rest } = parsed.document;
  return Object.keys(rest).length === 0 ? { kind: "empty" } : { kind: "rewritten", text: render(rest) };
}
