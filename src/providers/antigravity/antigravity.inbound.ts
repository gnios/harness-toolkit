import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";

/**
 * The variable the wiring sets, in the hook's own command text, to name the event being delivered.
 *
 * why: an agy payload never names its event — only the hook registration does — and PreInvocation and
 * PostInvocation payloads are byte-identical. The port hands `toEvent` the payload and nothing else, so the
 * registration has to put the name somewhere the adapter can read without the entrypoint, `run.ts` or core
 * learning that this host exists. The process environment is that place; it is the same channel the Orca hook
 * on this host already uses (`ORCA_ANTIGRAVITY_EVENT='Stop' /bin/sh …`) ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
export const ANTIGRAVITY_EVENT_ENV = "TLC_AGY_EVENT";

/**
 * why PreInvocation is `prompt.submit`: it fires once per invocation, before the model runs on what it was
 * asked — the turn boundary every stop-time gate diffs against. It carries no prompt text, so `text` stays
 * absent. PostInvocation is deliberately unmapped: there is no response text to carry, and the turn's end is
 * already `Stop`.
 */
export const EVENT_KIND_BY_HOOK: Record<string, HarnessEventKind> = {
  PreInvocation: "prompt.submit",
  Stop: "stop",
};

type ToolNameFanOutRule = { match: RegExp | string; kind: HarnessEventKind };

// why: PreToolUse fans out by `toolCall.name` — agy has one tool event, like Claude, not one per tool class.
// Write and edit stay `tool.before`, where the write-path rails already read them.
export const PRE_TOOL_USE_FAN_OUT: readonly ToolNameFanOutRule[] = [
  { match: "run_command", kind: "shell.before" },
  { match: "call_mcp_tool", kind: "mcp.before" },
  { match: "view_file", kind: "read.before" },
];

export const POST_TOOL_USE_FAN_OUT: readonly ToolNameFanOutRule[] = [
  { match: "run_command", kind: "shell.after" },
  { match: "call_mcp_tool", kind: "mcp.after" },
  { match: "write_to_file", kind: "edit.after" },
  { match: "replace_file_content", kind: "edit.after" },
];

/**
 * The host's file-writing tools, under the names the write-path rails already recognise.
 *
 * why translated here: the floor's wiring-tamper check, the edit-collision claim and the comment gate all key on
 * `Write`/`Edit` ([/decisions/ad-010.md](/decisions/ad-010.md)). Left as `write_to_file`, an agy write to a
 * protected path would read as an unknown tool and pass every one of them. The host's own name stays in `raw`.
 *
 * hazard: `replace_file_content` was never captured. Its name and its `TargetFile` field are assumed from the
 * write tool's shape; until a payload is observed, an edit through a differently named tool reaches only the
 * generic `tool.before` path ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
const WRITE_TOOL_NAMES: Record<string, string> = {
  write_to_file: "Write",
  replace_file_content: "Edit",
};

const MCP_TOOL = "call_mcp_tool";

type ToolCall = { name: string | undefined; args: Record<string, unknown> | undefined };

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function matchFanOut(
  table: readonly ToolNameFanOutRule[],
  toolName: string | undefined,
  fallback: HarnessEventKind,
): HarnessEventKind {
  if (toolName === undefined) {
    return fallback;
  }
  const rule = table.find((candidate) =>
    typeof candidate.match === "string" ? candidate.match === toolName : candidate.match.test(toolName),
  );
  return rule?.kind ?? fallback;
}

/**
 * why a shape fallback at all: the variable is set by the shell that runs the hook command. Where that shell
 * does not honour a leading assignment, a tool event and a stop are still unambiguous by shape — `toolCall`,
 * with or without `error`, and `terminationReason` — so the deny path keeps working. An invocation payload is
 * not, and gets no guess.
 */
function hookNameFromShape(raw: Record<string, unknown>): string | undefined {
  if (raw.toolCall !== undefined) {
    return typeof raw.error === "string" ? "PostToolUse" : "PreToolUse";
  }
  return typeof raw.terminationReason === "string" ? "Stop" : undefined;
}

function hookNameFor(raw: Record<string, unknown>): string | undefined {
  const declared = process.env[ANTIGRAVITY_EVENT_ENV]?.trim();
  return declared ? declared : hookNameFromShape(raw);
}

function toolCallOf(raw: Record<string, unknown>): ToolCall {
  const call = asRecord(raw.toolCall);
  return { name: asString(call?.name), args: asRecord(call?.args) };
}

function failed(raw: Record<string, unknown>): boolean {
  const error = asString(raw.error);
  return error !== undefined && error.length > 0;
}

/**
 * hazard: PreInvocation fires before every model call of an invocation, not once per prompt — measured at 56 for one
 * short task, `invocationNum` counting 0, 1, 2… Mapped whole, each was a turn boundary: once-per-turn markers
 * cleared mid-turn and the turn base re-captured after the turn's own edits.
 *
 * invariant: only a numeric `0` is the boundary. A payload without the counter is ignored rather than guessed —
 * a missed boundary falls back to diffing against HEAD, the existing safe default, while a false one corrupts the
 * turn ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
function isFirstInvocation(raw: Record<string, unknown>): boolean {
  return raw.invocationNum === 0;
}

function eventKindFor(
  hookName: string,
  raw: Record<string, unknown>,
  call: ToolCall,
): HarnessEventKind | undefined {
  if (hookName === "PreInvocation") {
    return isFirstInvocation(raw) ? EVENT_KIND_BY_HOOK.PreInvocation : undefined;
  }
  if (hookName === "PreToolUse") {
    return matchFanOut(PRE_TOOL_USE_FAN_OUT, call.name, "tool.before");
  }
  if (hookName === "PostToolUse") {
    return failed(raw) ? "tool.failure" : matchFanOut(POST_TOOL_USE_FAN_OUT, call.name, "tool.after");
  }
  return EVENT_KIND_BY_HOOK[hookName];
}

// why `mcp__<server>__<tool>`: the shape the MCP rule grammar already normalises, so an operator rule written
// for `create_pull_request` matches the same act on this host ([/decisions/ad-135.md](/decisions/ad-135.md)).
function harnessToolName(call: ToolCall): string | undefined {
  if (call.name === MCP_TOOL) {
    const server = asString(call.args?.ServerName);
    const tool = asString(call.args?.ToolName);
    return server && tool ? `mcp__${server}__${tool}` : call.name;
  }
  return call.name === undefined ? undefined : (WRITE_TOOL_NAMES[call.name] ?? call.name);
}

function harnessToolInput(call: ToolCall): Record<string, unknown> | undefined {
  return call.name === MCP_TOOL ? asRecord(call.args?.Arguments) : call.args;
}

function projectDirFor(raw: Record<string, unknown>): string {
  const roots = raw.workspacePaths;
  const first = Array.isArray(roots) ? asString(roots[0]) : undefined;
  return first || process.cwd();
}

function sessionKeyFor(raw: Record<string, unknown>): string {
  return `antigravity-${sanitizeSegment(asString(raw.conversationId) || "default")}`;
}

function fillShell(event: HarnessEvent, args: Record<string, unknown> | undefined): void {
  const command = asString(args?.CommandLine);
  if (command !== undefined) {
    event.command = command;
  }
  // why only the before-half: it is the event a rule proof's sha is resolved on, and the truthy check is the one
  // the other adapters converged on after an empty `cwd` overrode the real root
  // ([/decisions/ad-141.md](/decisions/ad-141.md)).
  const cwd = asString(args?.Cwd);
  if (event.event === "shell.before" && cwd) {
    event.cwd = cwd;
  }
}

function fillTool(event: HarnessEvent, call: ToolCall): void {
  const toolName = harnessToolName(call);
  if (toolName) {
    event.toolName = toolName;
  }
  const toolInput = harnessToolInput(call);
  if (toolInput) {
    event.toolInput = toolInput;
  }
  if (event.event === "mcp.before" || event.event === "mcp.after") {
    return;
  }
  const filePath = asString(call.args?.TargetFile) ?? asString(call.args?.AbsolutePath);
  if (filePath !== undefined) {
    event.filePath = filePath;
  }
  const command = asString(call.args?.CommandLine);
  if (command !== undefined) {
    event.command = command;
  }
  const proposedContent = asString(call.args?.CodeContent);
  if (toolName === "Write" && proposedContent !== undefined) {
    event.proposedContent = proposedContent;
  }
}

function fillByKind(event: HarnessEvent, raw: Record<string, unknown>, call: ToolCall): void {
  switch (event.event) {
    case "shell.before":
    case "shell.after":
      fillShell(event, call.args);
      return;
    case "read.before": {
      const filePath = asString(call.args?.AbsolutePath);
      if (filePath !== undefined) {
        event.filePath = filePath;
      }
      return;
    }
    case "stop":
      // why: agy has no session-end event, so this stop is the last one the harness is guaranteed to see.
      event.sessionEndUnreported = true;
      if (failed(raw)) {
        event.status = "error";
      }
      return;
    case "prompt.submit":
      return;
    default:
      fillTool(event, call);
  }
}

/**
 * Never throws on a malformed payload — returns null instead.
 *
 * hazard: `transcriptPath` is deliberately not surfaced. The only transcript reader the entrypoints have parses
 * another host's format, and it runs whenever a path is present ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
export function antigravityToEvent(raw: Record<string, unknown>): HarnessEvent | null {
  const hookName = hookNameFor(raw);
  if (!hookName) {
    return null;
  }
  const call = toolCallOf(raw);
  const eventKind = eventKindFor(hookName, raw, call);
  if (!eventKind) {
    return null;
  }

  const event: HarnessEvent = {
    provider: "antigravity",
    event: eventKind,
    sessionKey: sessionKeyFor(raw),
    projectDir: projectDirFor(raw),
    raw,
  };
  const model = asString(raw.modelName);
  if (model) {
    event.model = model;
  }
  fillByKind(event, raw, call);
  return event;
}
