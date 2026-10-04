import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessEvent } from "../../../contracts/index.ts";
import { antigravityRender } from "../antigravity.outbound.ts";

function eventOf(kind: HarnessEvent["event"]): HarnessEvent {
  return { provider: "antigravity", event: kind, sessionKey: "antigravity-s", projectDir: "/repo", raw: {} };
}

test("abstain renders an empty object, the response verified to let the agent carry on", () => {
  assert.deepEqual(antigravityRender({ kind: "abstain" }, eventOf("stop")), { stdout: "{}", exitCode: 0 });
});

test("allow renders the verified decision field", () => {
  assert.deepEqual(antigravityRender({ kind: "allow" }, eventOf("tool.before")), {
    stdout: '{"decision":"allow"}',
    exitCode: 0,
  });
});

test("deny renders decision deny with the reason the model is shown", () => {
  const rendered = antigravityRender(
    { kind: "deny", reason: "no", userNote: "for you", rule: "r" },
    eventOf("shell.before"),
  );
  assert.deepEqual(JSON.parse(rendered.stdout ?? ""), { decision: "deny", reason: "no" });
  assert.equal(rendered.exitCode, 0);
});

// invariant: `ask` was never verified on this host, and a gate whose outcome depends on unverified behaviour is
// not a gate. Degrade already turns it into a deny; this is the floor under that, for a path degrade lets through.
test("ask renders as a deny carrying the reason, never as an allow", () => {
  const rendered = antigravityRender({ kind: "ask", reason: "confirm?", rule: "r" }, eventOf("tool.before"));
  assert.deepEqual(JSON.parse(rendered.stdout ?? ""), { decision: "deny", reason: "confirm?" });
});

test("continue renders decision continue with the instruction as the reason", () => {
  const rendered = antigravityRender({ kind: "continue", text: "run the tests" }, eventOf("stop"));
  assert.deepEqual(JSON.parse(rendered.stdout ?? ""), { decision: "continue", reason: "run the tests" });
});

test("a rewriteInput that reaches render is refused, not silently allowed", () => {
  const rendered = antigravityRender(
    { kind: "rewriteInput", input: { CommandLine: "ls" }, reason: "safer" },
    eventOf("tool.before"),
  );
  const body = JSON.parse(rendered.stdout ?? "") as { decision: string; reason: string };
  assert.equal(body.decision, "deny");
  assert.match(body.reason, /safer/);
  assert.match(body.reason, /CommandLine/);
});

test("context and rewriteOutput have no verified field, so they render as carry-on", () => {
  assert.equal(antigravityRender({ kind: "context", text: "x" }, eventOf("prompt.submit")).stdout, "{}");
  assert.equal(antigravityRender({ kind: "rewriteOutput", output: "x" }, eventOf("tool.after")).stdout, "{}");
});
