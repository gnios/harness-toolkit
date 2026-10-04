import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { antigravityCapabilities } from "../antigravity.capabilities.ts";
import { detectAntigravity } from "../antigravity.detect.ts";
import { antigravityPolicyDefaults } from "../antigravity.policy-defaults.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

function fixtures(): { name: string; payload: unknown }[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, payload: JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) }));
}

test("every captured agy payload is detected", () => {
  const all = fixtures();
  assert.ok(all.length >= 8, `expected the captured fixtures, found ${all.length}`);
  for (const { name, payload } of all) {
    assert.equal(detectAntigravity(payload), true, name);
  }
});

test("rejects a Claude payload (hook_event_name + cwd)", () => {
  assert.equal(
    detectAntigravity({ hook_event_name: "PreToolUse", cwd: "/repo", transcript_path: "/tmp/t.jsonl" }),
    false,
  );
});

test("rejects a Cursor payload (conversation_id + workspace_roots)", () => {
  assert.equal(
    detectAntigravity({ hook_event_name: "stop", conversation_id: "c1", workspace_roots: ["/repo"] }),
    false,
  );
});

// invariant: the event name is never in an agy payload. One that carries it belongs to a host that names its
// events, so claiming it would make two providers answer the same payload.
test("rejects an otherwise agy-shaped payload that carries hook_event_name", () => {
  assert.equal(
    detectAntigravity({ hook_event_name: "Stop", conversationId: "c1", workspacePaths: ["/repo"] }),
    false,
  );
});

test("rejects a payload missing workspacePaths", () => {
  assert.equal(detectAntigravity({ conversationId: "c1" }), false);
});

test("rejects a payload whose workspacePaths is not an array", () => {
  assert.equal(detectAntigravity({ conversationId: "c1", workspacePaths: "/repo" }), false);
});

test("rejects null, a string, an array and an empty object", () => {
  assert.equal(detectAntigravity(null), false);
  assert.equal(detectAntigravity("Stop"), false);
  assert.equal(detectAntigravity([{ conversationId: "c1", workspacePaths: [] }]), false);
  assert.equal(detectAntigravity({}), false);
});

test("capabilities declare only what was verified against agy 1.2.16", () => {
  assert.deepEqual(antigravityCapabilities(), {
    enforcesHooks: true,
    askSupportedOn: [],
    sessionEnv: false,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: false,
    toolOutputRewriteOn: [],
    contextAtToolBefore: false,
    contextAtToolAfter: false,
    contextAtStop: false,
    sessionStartContextReliable: false,
    toolOutputAtAfter: false,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
  });
});

test("policy defaults ship no allowlist and no blocked patterns", () => {
  assert.deepEqual(antigravityPolicyDefaults(), {
    blockedPatterns: [],
    minEffort: null,
    untrustedTools: [],
  });
});
