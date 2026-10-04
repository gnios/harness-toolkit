---
type: Provider
title: "Antigravity provider"
description: "The Antigravity CLI (agy) adapter — what was verified against agy 1.2.16, what was not, the event mapping, and the named hook set it merges into ~/.gemini/config/hooks.json."
tags: [provider, antigravity]
timestamp: "2026-10-04"
---

# Antigravity provider

Source: `src/providers/antigravity/`. Decision: [/decisions/ad-146.md](/decisions/ad-146.md).

Everything below marked **verified** was observed against `agy` 1.2.16 with a hook that captured each payload
and tried each response. The public documentation disagreed with the binary and is not used as evidence. The
captured payloads are the adapter's test fixtures (`src/providers/antigravity/__test__/fixtures/`), with the
home and workspace paths replaced by placeholders and nothing else changed. `PostToolUse.run_command.json` is
derived: the PreToolUse payload plus `"error": ""`, the exact key set an earlier PostToolUse capture showed.

## Detection

`antigravity.detect.ts`: a payload is agy's when `conversationId` is a string, `workspacePaths` is an array, and
there is **no** `hook_event_name`. Claude and Cursor payloads always carry `hook_event_name`, so the three
detections are disjoint — asserted against every captured fixture of all three hosts in
`src/providers/__test__/provider.detect-disjoint.test.ts`.

## How the adapter learns the event

The payload never names its event (**verified**), and `PreInvocation`/`PostInvocation` payloads are identical.
The wiring therefore writes the event into the hook command's environment:

```text
TLC_AGY_EVENT=PreToolUse node <launcher> tool-before
```

`antigravity.inbound.ts` reads `TLC_AGY_EVENT`. Without it, a payload with `toolCall` is `PreToolUse` (or
`PostToolUse` when it also has `error`) and one with `terminationReason` is `Stop`; an invocation payload is
unrecognized. The assignment depends on a POSIX shell — the Orca hook on the same host uses the same form — and
Windows was not tried.

## Capability descriptor

`antigravity.capabilities.ts`:

<!-- generated:capabilities -->

| Capability | Value |
|---|---|
| `enforcesHooks` | `true` |
| `askSupportedOn` | `[]` |
| `sessionEnv` | `false` |
| `nativeLoopCounter` | `false` |
| `dedicatedShellEvent` | `false` |
| `toolInputRewrite` | `false` |
| `toolOutputRewriteOn` | `[]` |
| `contextAtToolBefore` | `false` |
| `contextAtToolAfter` | `false` |
| `contextAtStop` | `false` |
| `sessionStartContextReliable` | `false` |
| `toolOutputAtAfter` | `false` |
| `usageInPayload` | `false` |
| `effortSignal` | `false` |
| `thoughtEvent` | `false` |

<!-- /generated -->

| Response | Status |
| --- | --- |
| PreToolUse `{"decision":"deny","reason":"…"}` | **verified** — the tool does not run; the model sees `tool call denied by pre-tool hook: <reason>` |
| PreToolUse `{"decision":"allow"}` | **verified** |
| Stop `{"decision":"continue","reason":"…"}` | **verified** — the agent does not stop and follows `reason` |
| Stop `{}` | **verified** — the agent stops |
| `ask` | not verified — declared unsupported, so degrade turns it into a deny |
| Context injection (PreInvocation or any event) | not verified — every `contextAt*` is `false` |
| Input/output rewrite | not verified — declared unsupported |

PostToolUse carries `error` and **no** stdout or exit code, so `toolOutputAtAfter` is `false`. **`error` is not
a failure signal for `run_command`** (verified): an `ls` of a missing directory exits 2 and still arrives with
`error: ""`. See [A failed command looks like a passing one](#a-failed-command-looks-like-a-passing-one).

## Policy defaults

`antigravity.policy-defaults.ts` ships nothing: no blocked patterns and no untrusted tools. No agy tool that
fetches outside content was captured.

## Event mapping

`antigravity.inbound.ts` maps agy's hook names, and fans `PreToolUse`/`PostToolUse` out by `toolCall.name`:

<!-- generated:event-mapping -->

| Hook | Fan-out rule | HarnessEventKind |
|---|---|---|
| `PreInvocation` | — | `prompt.submit` |
| `Stop` | — | `stop` |
| `PreToolUse` | tool_name === "run_command" | `shell.before` |
| `PreToolUse` | tool_name === "call_mcp_tool" | `mcp.before` |
| `PreToolUse` | tool_name === "view_file" | `read.before` |
| `PostToolUse` | tool_name === "run_command" | `shell.after` |
| `PostToolUse` | tool_name === "call_mcp_tool" | `mcp.after` |
| `PostToolUse` | tool_name === "write_to_file" | `edit.after` |
| `PostToolUse` | tool_name === "replace_file_content" | `edit.after` |

<!-- /generated -->

Any other tool is `tool.before`/`tool.after`. A `PostToolUse` whose `error` is non-empty is `tool.failure`,
whatever the tool. `PostInvocation` is not mapped and not wired.

`PreInvocation` is `prompt.submit` **only when `invocationNum` is the number `0`**. It fires before every model
call, not every prompt — 56 times for one short task against the real binary, `invocationNum` counting 0, 1, 2…
— and `prompt.submit` is the turn boundary: it clears once-per-turn markers and records the commit every
stop-time gate diffs against. A later call, or a payload without a numeric `invocationNum`, is ignored rather
than guessed: a missed boundary falls back to diffing against `HEAD`, while a false one would reset the turn
mid-turn. Each ignored call still leaves one `adapter.unrecognized` record (`reason: unrecognized-event`) in the
workspace's `obs.jsonl`. It carries no prompt text.

**Not verified:** whether `invocationNum` restarts at `0` for each prompt of an interactive conversation, or
counts across the conversation. Only `agy -p` was observed; if it counts across, later prompts get no boundary
and their gates diff against the first prompt's base.

### The session ends at Stop

agy has no session-end event, so the file claims that `session-end` releases on other hosts stood for the full
ten-minute stale window — measured: three consecutive `agy -p` runs had the same `Write` refused as
`edit-collision`. Every agy `stop` carries `sessionEndUnreported: true`, and the `stop` entrypoint releases the
session's presence (its claims) when it lets the agent stop. It does **not** release on a `continue`: the agent
keeps working, and its claims cover every file it wrote that turn — only the next file it writes would be
reclaimed. Nothing else `session-end` does runs here; in particular the stop-loop counter is not reset, which a
per-stop reset would make the grind cap unreachable. In an interactive conversation this releases at the end of
every turn, so another session's write in between is no longer asked about.

### A failed command looks like a passing one

Verified against the real binary, and **not fixable from the hook today**:

- PostToolUse carries `error: ""` for a `run_command` that exits non-zero (an `ls` of a missing directory, exit 2).
- The transcript does not hold the step's result when PostToolUse fires: only earlier steps are there, and waiting
  3 s inside the hook does not make it appear — agy writes the step after every hook has returned.

So a `run_command` with an empty `error` is a `shell.after` carrying its command, and **a `command(…)` proof can
be satisfied by a red command on agy**. On Claude the same failure is a PostToolUseFailure and counts for nothing.
The existing mitigation is the stop-time grind, which runs lint and tests itself and checks the real result.
Reading the exit code from the transcript was tried and reverted: the step is never there yet, so no command,
passing or not, ever counted, and a rule proven by a command could never be satisfied.

The way forward, not implemented: reconcile on the **next** event (a `PreInvocation` with `invocationNum > 0`, a
`PreToolUse`, or `Stop`), when the previous step is already in the transcript, and revoke the proof if the step
exited non-zero. That needs new core support — there is no proof revocation today.

### Where a command's relative paths resolve

`run_command` carries `Cwd`, a directory the agent chooses per call. The adapter sets it as
`HarnessEvent.commandCwd`, and the floor resolves the command's relative words there; the project boundary is
still `projectDir`. Without it, `echo '{}' > hooks.json` with `Cwd` set to `~/.gemini/config` and a climb from a
subdirectory into the project's policy file were both allowed. Claude's and Cursor's `cwd` is not a per-call
argument, so they do not set `commandCwd` and keep resolving against the project.

### An edit tool with an unknown name

Any tool other than the mapped ones that carries a string `TargetFile` is translated to `Edit`, so the floor's
`wiring-tamper` rule and operator rules on `tool(Edit)` see it as a write — measured: `multi_replace_file_content`
on the global hooks file was allowed before. `view_file` (which uses `AbsolutePath`) and tools without
`TargetFile` keep their own names. **Not verified:** the real names of agy's edit tools —
`replace_file_content` and `multi_replace_file_content` were never captured.

Fields: `toolCall.args.CommandLine` → `command`; `run_command`'s `Cwd` → `cwd` and `commandCwd` on `shell.before`
only; `TargetFile`/`AbsolutePath` → `filePath`; `write_to_file` → `toolName: "Write"` with `CodeContent` as
`proposedContent`; `replace_file_content`, and any unmapped tool with `TargetFile`, → `toolName: "Edit"`;
`call_mcp_tool` →
`toolName: "mcp__<ServerName>__<ToolName>"` with `Arguments` as `toolInput`; `modelName` → `model`;
`conversationId` → `sessionKey` (`antigravity-<id>`); `workspacePaths[0]` → `projectDir`. `transcriptPath` is
not surfaced — the only transcript reader in the entrypoints parses another host's format.

## Wiring target

`antigravity.wiring.ts` merges (`strategy: "named-merge"`) into the user-level `~/.gemini/config/hooks.json`.
That file is an object of named hook sets; ours is `tlc-harness`, replaced whole on each write, and every other
set — the Orca hook `orca-status`, on the machine this was built against — keeps its value and position. An
`enabled` flag the operator set on `tlc-harness` is kept. A file that does not parse is refused, never
overwritten.

| Event | Handler | Timeout (s) | Shape |
| --- | --- | --- | --- |
| `PreInvocation` | `prompt-submit` | 5 | `[{"type":"command","command":…,"timeout":5}]` |
| `PreToolUse` | `tool-before` | 10 | `[{"matcher":"*","hooks":[{"type":"command",…}]}]` |
| `PostToolUse` | `tool-after` | 10 | `[{"matcher":"*","hooks":[{"type":"command",…}]}]` |
| `Stop` | `stop` | 120 | `[{"type":"command","command":…,"timeout":120}]` |

`wiringTargets(projectDir)` also names `<project>/.agents/hooks.json`, which agy loads without asking; both are
protected by the floor's `wiring-tamper` rule, whichever host's agent writes them. `tlc harness init` does not yet
write a workspace-level hook set.

## Lessons view

None. Which file agy reads as standing instructions was not established, and writing lessons into a file the
agent never reads would report a durable view that does not exist.

## Doctor / status

`tlc harness doctor` reports agy wiring as `wired` when merging would change nothing, `detected-but-unwired`
otherwise, and `not-installed` when `~/.gemini/config/` is absent. `tlc harness uninstall` removes only the
`tlc-harness` set, or the file when that set was all it held.

## See also

- [/providers/index.md](/providers/index.md)
- [/decisions/ad-146.md](/decisions/ad-146.md)
