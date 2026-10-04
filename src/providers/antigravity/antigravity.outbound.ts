import type { Decision, HarnessEvent, Rendered } from "../../contracts/index.ts";

// why `{}`: the response verified to let a Stop end normally, and the same no-opinion shape the launcher emits
// when the runtime cannot start. Empty stdout was never tried on this host.
const CARRY_ON = "{}";

function refuse(reason: string): Rendered {
  return { stdout: JSON.stringify({ decision: "deny", reason }), exitCode: 0 };
}

export function antigravityRender(decision: Decision, _event: HarnessEvent): Rendered {
  switch (decision.kind) {
    case "abstain":
      return { stdout: CARRY_ON, exitCode: 0 };
    case "allow":
      return { stdout: JSON.stringify({ decision: "allow" }), exitCode: 0 };
    // why the reason alone: it is what the model is shown ("tool call denied by pre-tool hook: <reason>"). No field
    // for an operator-only note was found, so `userNote` has nowhere to go.
    case "deny":
      return refuse(decision.reason);
    // hazard: `ask` is unverified here, and degrade already turns it into a deny. It still reaches render when
    // degrade produces it — a rewrite this host cannot apply becomes an ask — so the floor under that path is a
    // refusal that carries the question, never a silent pass ([/decisions/ad-146.md](/decisions/ad-146.md)).
    case "ask":
      return refuse(decision.reason);
    case "rewriteInput":
      return refuse(`${decision.reason} (proposed input: ${JSON.stringify(decision.input)})`);
    // why: verified at Stop — the agent did not stop, and carried out the instruction in `reason`.
    case "continue":
      return { stdout: JSON.stringify({ decision: "continue", reason: decision.text }), exitCode: 0 };
    // hazard: no response field for injected context or a rewritten output was found. Rendering into a guessed
    // field would read as delivered while the model saw nothing; the capabilities already make degrade abstain.
    case "context":
    case "rewriteOutput":
      return { stdout: CARRY_ON, exitCode: 0 };
    default: {
      const exhaustive: never = decision;
      throw new Error(`unreachable decision kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
