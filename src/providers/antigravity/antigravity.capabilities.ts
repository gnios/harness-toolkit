import type { ProviderCapabilities } from "../../contracts/index.ts";

/**
 * invariant: every `true` here was observed against agy 1.2.16, and everything not observed is `false` — the
 * public documentation disagrees with the binary, so it is not evidence ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
export function antigravityCapabilities(): ProviderCapabilities {
  return {
    // why: `{"decision":"deny","reason":…}` on PreToolUse was verified to stop the tool, and the model received
    // "tool call denied by pre-tool hook: <reason>".
    enforcesHooks: true,
    // hazard: `ask` was never observed. Declaring it would let an escalation reach a host whose answer to it is
    // unknown; empty makes degrade turn every ask into a deny that says why.
    askSupportedOn: [],
    sessionEnv: false,
    nativeLoopCounter: false,
    // why: shell arrives as `run_command` inside PreToolUse and is fanned out by tool name, as on Claude.
    dedicatedShellEvent: false,
    toolInputRewrite: false,
    toolOutputRewriteOn: [],
    // hazard: the response field that injects context (PreInvocation or otherwise) was not found. A context
    // decision rendered into a guessed field is delivered to no one while the rail believes it spoke.
    contextAtToolBefore: false,
    contextAtToolAfter: false,
    // why: Stop does carry a `reason`, but only with `decision: "continue"`, which forces another turn — that is
    // `continue`, not a non-blocking advisory, so it is not a context channel.
    contextAtStop: false,
    sessionStartContextReliable: false,
    // why: PostToolUse carries `error` (empty on success) and no stdout or exit code.
    toolOutputAtAfter: false,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
  };
}
