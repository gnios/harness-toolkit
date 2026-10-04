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

PostToolUse carries `error` (an empty string on success) and **no** stdout or exit code, so
`toolOutputAtAfter` is `false`.

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

`PreInvocation` is `prompt.submit` because it is the turn boundary: it fires before the model runs, and
`prompt-submit` records the commit every stop-time gate diffs against. It carries no prompt text.

Fields: `toolCall.args.CommandLine` → `command`; `run_command`'s `Cwd` → `cwd` on `shell.before` only;
`TargetFile`/`AbsolutePath` → `filePath`; `write_to_file` → `toolName: "Write"` with `CodeContent` as
`proposedContent`; `replace_file_content` → `toolName: "Edit"`; `call_mcp_tool` →
`toolName: "mcp__<ServerName>__<ToolName>"` with `Arguments` as `toolInput`; `modelName` → `model`;
`conversationId` → `sessionKey` (`antigravity-<id>`); `workspacePaths[0]` → `projectDir`. `transcriptPath` is
not surfaced — the only transcript reader parses another host's format.

**Not verified:** `replace_file_content` was never captured; its name and its `TargetFile` field are assumed from
`write_to_file`.

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
