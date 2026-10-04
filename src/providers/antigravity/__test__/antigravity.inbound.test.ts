import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ANTIGRAVITY_EVENT_ENV,
  antigravityToEvent,
  EVENT_KIND_BY_HOOK,
  POST_TOOL_USE_FAN_OUT,
  PRE_TOOL_USE_FAN_OUT,
} from "../antigravity.inbound.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const WORKSPACE = "/private/tmp/agyws";
const SESSION_KEY = "antigravity-3520b054-a345-44f5-bfcd-305ebac54fe3";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;
}

function withToolCall(name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...fixture("PreToolUse.run_command"), toolCall: { name, args }, ...extra };
}

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ANTIGRAVITY_EVENT_ENV];
  delete process.env[ANTIGRAVITY_EVENT_ENV];
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env[ANTIGRAVITY_EVENT_ENV];
  } else {
    process.env[ANTIGRAVITY_EVENT_ENV] = saved;
  }
});

function asHook(hookName: string): void {
  process.env[ANTIGRAVITY_EVENT_ENV] = hookName;
}

// why: these tables are what the provider doc's generated mapping is rendered from, so they are asserted as data
// and not only through the behaviour they drive.
test("the published mapping tables name every captured tool and the two direct hooks", () => {
  assert.deepEqual(EVENT_KIND_BY_HOOK, { PreInvocation: "prompt.submit", Stop: "stop" });
  assert.deepEqual(
    PRE_TOOL_USE_FAN_OUT.map((rule) => [rule.match, rule.kind]),
    [
      ["run_command", "shell.before"],
      ["call_mcp_tool", "mcp.before"],
      ["view_file", "read.before"],
    ],
  );
  assert.deepEqual(
    POST_TOOL_USE_FAN_OUT.map((rule) => [rule.match, rule.kind]),
    [
      ["run_command", "shell.after"],
      ["call_mcp_tool", "mcp.after"],
      ["write_to_file", "edit.after"],
      ["replace_file_content", "edit.after"],
    ],
  );
});

test("the event variable is the one the wiring writes", () => {
  assert.equal(ANTIGRAVITY_EVENT_ENV, "TLC_AGY_EVENT");
});

test("PreInvocation is the turn boundary: prompt.submit, with session, project and model", () => {
  asHook("PreInvocation");
  const event = antigravityToEvent(fixture("PreInvocation"));
  assert.ok(event);
  assert.equal(event.provider, "antigravity");
  assert.equal(event.event, "prompt.submit");
  assert.equal(event.sessionKey, SESSION_KEY);
  assert.equal(event.projectDir, WORKSPACE);
  assert.equal(event.model, "gemini-3.8-flash-medium");
  assert.equal(event.text, undefined);
});

// invariant: PreInvocation and PostInvocation carry byte-identical payloads, so without the variable there is
// nothing to tell them apart — and guessing would reset the turn base after the turn ran.
test("an invocation payload with no event variable is unrecognized rather than guessed", () => {
  assert.equal(antigravityToEvent(fixture("PreInvocation")), null);
  assert.equal(antigravityToEvent(fixture("PostInvocation")), null);
});

// why: PreInvocation fires before every model call, not every prompt — 56 of them for one short task against the
// real binary. Only the first call of an invocation is the turn boundary prompt.submit stands for.
test("a PreInvocation after the first model call is ignored, not a second turn boundary", () => {
  asHook("PreInvocation");
  assert.equal(fixture("PreInvocation").invocationNum, 0);
  assert.equal(fixture("PreInvocation.invocation1").invocationNum, 1);
  assert.equal(antigravityToEvent(fixture("PreInvocation.invocation1")), null);
  assert.equal(antigravityToEvent({ ...fixture("PreInvocation"), invocationNum: 7 }), null);
});

// invariant: no guess. Without the counter the first call cannot be told from the fifty-fifth, and a missed
// boundary falls back to diffing against HEAD while a false one resets once-per-turn state mid-turn.
test("a PreInvocation without a numeric invocationNum is ignored", () => {
  asHook("PreInvocation");
  const { invocationNum: _n, ...withoutCounter } = fixture("PreInvocation");
  assert.equal(antigravityToEvent(withoutCounter), null);
  assert.equal(antigravityToEvent({ ...fixture("PreInvocation"), invocationNum: "0" }), null);
});

// why: agy never reports the end of a session, so the stop is the last point the harness is guaranteed to see.
test("Stop marks the session end as unreported; other events do not", () => {
  asHook("Stop");
  assert.equal(antigravityToEvent(fixture("Stop"))?.sessionEndUnreported, true);
  asHook("PreToolUse");
  assert.equal(antigravityToEvent(fixture("PreToolUse.run_command"))?.sessionEndUnreported, undefined);
});

test("PostInvocation is not mapped", () => {
  asHook("PostInvocation");
  assert.equal(antigravityToEvent(fixture("PostInvocation")), null);
});

test("an unknown event name is unrecognized", () => {
  asHook("SomethingNew");
  assert.equal(antigravityToEvent(fixture("Stop")), null);
});

test("PreToolUse run_command fans out to shell.before with command and cwd", () => {
  asHook("PreToolUse");
  const event = antigravityToEvent(fixture("PreToolUse.run_command"));
  assert.ok(event);
  assert.equal(event.event, "shell.before");
  assert.equal(event.command, 'echo "oi" > hello.txt');
  assert.equal(event.cwd, WORKSPACE);
});

test("PreToolUse write_to_file is a Write at tool.before, with path and proposed content", () => {
  asHook("PreToolUse");
  const event = antigravityToEvent(fixture("PreToolUse.write_to_file"));
  assert.ok(event);
  assert.equal(event.event, "tool.before");
  assert.equal(event.toolName, "Write");
  assert.equal(event.filePath, `${WORKSPACE}/hello.txt`);
  assert.equal(event.proposedContent, "oi");
  assert.equal(event.toolInput?.TargetFile, `${WORKSPACE}/hello.txt`);
});

test("PreToolUse replace_file_content (unverified shape) is an Edit at tool.before with its TargetFile", () => {
  asHook("PreToolUse");
  const event = antigravityToEvent(withToolCall("replace_file_content", { TargetFile: "/repo/a.ts" }));
  assert.ok(event);
  assert.equal(event.event, "tool.before");
  assert.equal(event.toolName, "Edit");
  assert.equal(event.filePath, "/repo/a.ts");
  // why: the old/new text fields were never captured, so nothing is guessed into the edit-diff fields.
  assert.equal(event.proposedContent, undefined);
  assert.equal(event.proposedOldContent, undefined);
});

// why: the edit tools were never all captured. Any tool that names a TargetFile is treated as a write, so a
// differently named edit tool cannot reach a protected path as an unknown, unchecked tool.
test("an unmapped tool carrying TargetFile is an Edit", () => {
  asHook("PreToolUse");
  const event = antigravityToEvent(
    withToolCall("multi_replace_file_content", { TargetFile: "/repo/a.ts", ReplacementChunks: [] }),
  );
  assert.ok(event);
  assert.equal(event.event, "tool.before");
  assert.equal(event.toolName, "Edit");
  assert.equal(event.filePath, "/repo/a.ts");
});

test("an unmapped tool with no TargetFile keeps its own name", () => {
  asHook("PreToolUse");
  const event = antigravityToEvent(withToolCall("list_dir", { DirectoryPath: "/repo" }));
  assert.equal(event?.toolName, "list_dir");
});

test("view_file is never an Edit, and write_to_file stays a Write", () => {
  asHook("PreToolUse");
  const view = antigravityToEvent(withToolCall("view_file", { AbsolutePath: "/a", TargetFile: "/a" }));
  assert.equal(view?.event, "read.before");
  assert.equal(view?.toolName, undefined);
  assert.equal(antigravityToEvent(fixture("PreToolUse.write_to_file"))?.toolName, "Write");
});

test("run_command's Cwd is the command's own directory", () => {
  asHook("PreToolUse");
  assert.equal(antigravityToEvent(fixture("PreToolUse.run_command"))?.commandCwd, WORKSPACE);
});

test("PreToolUse view_file fans out to read.before with the absolute path", () => {
  asHook("PreToolUse");
  const event = antigravityToEvent(fixture("PreToolUse.view_file"));
  assert.ok(event);
  assert.equal(event.event, "read.before");
  assert.equal(event.filePath, "/Users/dev/.gemini/antigravity-cli");
});

test("PreToolUse call_mcp_tool fans out to mcp.before with the mcp__server__tool name and its arguments", () => {
  asHook("PreToolUse");
  const event = antigravityToEvent(
    withToolCall("call_mcp_tool", {
      ServerName: "github",
      ToolName: "create_pull_request",
      Arguments: { owner: "o", repo: "r" },
    }),
  );
  assert.ok(event);
  assert.equal(event.event, "mcp.before");
  assert.equal(event.toolName, "mcp__github__create_pull_request");
  assert.deepEqual(event.toolInput, { owner: "o", repo: "r" });
});

test("the captured call_mcp_tool fixture names its server and tool", () => {
  asHook("PreToolUse");
  const event = antigravityToEvent(fixture("PreToolUse.call_mcp_tool"));
  assert.equal(event?.toolName, "mcp__gnios__gnios_status");
  assert.deepEqual(event?.toolInput, {});
});

test("PreToolUse of a tool with no fan-out is a generic tool.before carrying the host's own name", () => {
  asHook("PreToolUse");
  const event = antigravityToEvent(withToolCall("search_web", { query: "x" }));
  assert.ok(event);
  assert.equal(event.event, "tool.before");
  assert.equal(event.toolName, "search_web");
  assert.deepEqual(event.toolInput, { query: "x" });
});

/**
 * The transcript as it really is when PostToolUse fires: verified against agy, the step whose result the hook
 * reports is written only after the hooks finish — not even after waiting 3 s inside the hook. Only earlier
 * steps are there.
 */
function transcriptWithoutTheStep(): string {
  const dir = mkdtempSync(join(tmpdir(), "agy-transcript-"));
  const path = join(dir, "transcript_full.jsonl");
  const lines = [0, 1].map((step) =>
    JSON.stringify({ step_index: step, source: "MODEL", type: "GENERIC", status: "DONE", content: "x" }),
  );
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

test("PostToolUse run_command with an empty error fans out to shell.after", () => {
  asHook("PostToolUse");
  const event = antigravityToEvent(fixture("PostToolUse.run_command"));
  assert.ok(event);
  assert.equal(event.event, "shell.after");
  assert.equal(event.command, 'echo "oi" > hello.txt');
  // why: the host reports cwd per command, but only the before-half records it — the same rule the other adapters follow.
  assert.equal(event.cwd, undefined);
  assert.equal(event.toolOutput, undefined);
});

/**
 * hazard: reading the exit code from the transcript made every successful command unproven, because the step is
 * never there yet — measured: a passing `ruff format --check` was then reported missing at push, and a context
 * rule proven by a command could never be satisfied ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
test("an empty-error run_command carries its command, whatever the transcript holds at that moment", () => {
  asHook("PostToolUse");
  const transcriptPath = transcriptWithoutTheStep();
  try {
    const event = antigravityToEvent({ ...fixture("PostToolUse.run_command"), transcriptPath });
    assert.ok(event);
    assert.equal(event.event, "shell.after");
    assert.equal(event.command, 'echo "oi" > hello.txt');
    assert.equal(event.transcriptPath, undefined);
  } finally {
    rmSync(dirname(transcriptPath), { recursive: true, force: true });
  }
});

test("PostToolUse with a non-empty error is tool.failure, whatever the tool", () => {
  asHook("PostToolUse");
  const event = antigravityToEvent({ ...fixture("PostToolUse.run_command"), error: "exit status 1" });
  assert.ok(event);
  assert.equal(event.event, "tool.failure");
  assert.equal(event.command, 'echo "oi" > hello.txt');
});

test("PostToolUse write_to_file is edit.after with the written path", () => {
  asHook("PostToolUse");
  const event = antigravityToEvent({ ...fixture("PreToolUse.write_to_file"), error: "" });
  assert.ok(event);
  assert.equal(event.event, "edit.after");
  assert.equal(event.toolName, "Write");
  assert.equal(event.filePath, `${WORKSPACE}/hello.txt`);
});

test("PostToolUse call_mcp_tool is mcp.after", () => {
  asHook("PostToolUse");
  const event = antigravityToEvent({ ...fixture("PreToolUse.call_mcp_tool"), error: "" });
  assert.equal(event?.event, "mcp.after");
  assert.equal(event?.toolName, "mcp__gnios__gnios_status");
});

test("PostToolUse of a tool with no fan-out is a generic tool.after", () => {
  asHook("PostToolUse");
  const event = antigravityToEvent({ ...fixture("PreToolUse.view_file"), error: "" });
  assert.equal(event?.event, "tool.after");
  assert.equal(event?.toolName, "view_file");
});

test("Stop that ended cleanly is a stop with no status", () => {
  asHook("Stop");
  const event = antigravityToEvent(fixture("Stop"));
  assert.ok(event);
  assert.equal(event.event, "stop");
  assert.equal(event.status, undefined);
  assert.equal(event.sessionKey, SESSION_KEY);
});

test("Stop that carries an error is a stop with status error", () => {
  asHook("Stop");
  const event = antigravityToEvent({ ...fixture("Stop"), error: "model overloaded" });
  assert.equal(event?.status, "error");
});

// why: the transcript is agy's own format; handing its path to a reader built for another host's transcript
// would parse foreign lines as usage.
test("the transcript path is not surfaced", () => {
  asHook("Stop");
  assert.equal(antigravityToEvent(fixture("Stop"))?.transcriptPath, undefined);
});

test("without the variable, tool and stop payloads are recognized by their own shape", () => {
  assert.equal(antigravityToEvent(fixture("PreToolUse.run_command"))?.event, "shell.before");
  assert.equal(antigravityToEvent(fixture("PostToolUse.run_command"))?.event, "shell.after");
  assert.equal(antigravityToEvent(fixture("Stop"))?.event, "stop");
});

test("the variable wins over the shape", () => {
  asHook("Stop");
  assert.equal(antigravityToEvent(fixture("PreToolUse.run_command"))?.event, "stop");
});

test("a malformed toolCall never throws", () => {
  asHook("PreToolUse");
  const event = antigravityToEvent({ ...fixture("PreToolUse.run_command"), toolCall: "garbage" });
  assert.equal(event?.event, "tool.before");
  assert.equal(event?.toolName, undefined);
});

test("no conversationId and no workspacePaths fall back to a default key and the process cwd", () => {
  asHook("Stop");
  const event = antigravityToEvent({ terminationReason: "NO_TOOL_CALL" });
  assert.equal(event?.sessionKey, "antigravity-default");
  assert.equal(event?.projectDir, process.cwd());
});
