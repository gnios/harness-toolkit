import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Decision, HarnessEvent } from "../../contracts/index.ts";
import { coreFacade } from "../../core/index.ts";
import { runHandler } from "../run.ts";
import { releaseUnreportedSession, stopHandler } from "../stop.ts";
import { toolBeforeHandler } from "../tool-before.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tlc-presence-release-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, ".gitignore"), ".tlc/\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function stdinOf(text: string) {
  return { readStdin: () => Promise.resolve(text) };
}

function agyWrite(root: string, conversationId: string): string {
  return JSON.stringify({
    conversationId,
    workspacePaths: [root],
    modelName: "gemini-3.8-flash-medium",
    toolCall: { name: "write_to_file", args: { TargetFile: join(root, "src", "app.ts"), CodeContent: "x" } },
  });
}

function agyStop(root: string, conversationId: string): string {
  return JSON.stringify({
    conversationId,
    workspacePaths: [root],
    modelName: "gemini-3.8-flash-medium",
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
    executionNum: 0,
    error: "",
  });
}

function claudeWrite(root: string, sessionId: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: root,
    session_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: join(root, "src", "app.ts"), content: "x" },
  });
}

function claudeStop(root: string, sessionId: string): string {
  return JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: sessionId });
}

function ruleOf(decision: Decision): string | undefined {
  return decision.kind === "deny" || decision.kind === "ask" ? decision.rule : undefined;
}

/**
 * The defect this pins: agy has no session-end event, so a claim taken by one `agy -p` run outlived it by ten
 * minutes and the next run's write to the same file was refused as `edit-collision` — three times in a row,
 * measured against the real binary ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
test("an agy stop that lets the agent stop releases its claims, so the next run may write the same file", async () => {
  const root = initRepo();
  try {
    await runHandler(toolBeforeHandler, stdinOf(agyWrite(root, "run-1")));
    // why: asked directly, not through a second write — a refused write still heartbeats its own claim, so a
    // probe through the hook would leave a second claimant behind and test that one instead.
    const file = join(root, "src", "app.ts");
    assert.equal(
      coreFacade.presence.checkCollision(root, file, "antigravity-run-2").kind,
      "ask",
      "the claim exists before the stop",
    );

    await runHandler(stopHandler, stdinOf(agyStop(root, "run-1")));

    const after = await runHandler(toolBeforeHandler, stdinOf(agyWrite(root, "run-3")));
    assert.notEqual(ruleOf(after.decision), "edit-collision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// invariant: a host that does report its session end keeps its claims across a turn's stop. Only the host that
// never says the session ended loses them here.
test("a Claude stop does not release the session's claims", async () => {
  const root = initRepo();
  try {
    await runHandler(toolBeforeHandler, stdinOf(claudeWrite(root, "s1")));
    await runHandler(stopHandler, stdinOf(claudeStop(root, "s1")));
    const other = await runHandler(toolBeforeHandler, stdinOf(claudeWrite(root, "s2")));
    assert.equal(ruleOf(other.decision), "edit-collision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function agyStopEvent(root: string): HarnessEvent {
  return {
    provider: "antigravity",
    event: "stop",
    sessionKey: "antigravity-run-1",
    projectDir: root,
    sessionEndUnreported: true,
    raw: {},
  };
}

/**
 * why not on `continue`: the agent keeps working, and the claim covers every file it wrote earlier in the turn —
 * not only the next one. Releasing there would leave those files unclaimed until each is written again.
 */
test("a stop that forces the agent to continue keeps its claims", () => {
  const root = initRepo();
  try {
    const file = join(root, "src", "app.ts");
    coreFacade.presence.heartbeat(root, { provider: "antigravity", session: "run-1", file });
    releaseUnreportedSession(agyStopEvent(root), { kind: "continue", text: "run the tests" });
    assert.equal(coreFacade.presence.checkCollision(root, file, "antigravity-run-2").kind, "ask");

    releaseUnreportedSession(agyStopEvent(root), { kind: "abstain" });
    assert.equal(coreFacade.presence.checkCollision(root, file, "antigravity-run-2").kind, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stop event without the flag never releases", () => {
  const root = initRepo();
  try {
    const file = join(root, "src", "app.ts");
    coreFacade.presence.heartbeat(root, { provider: "antigravity", session: "run-1", file });
    const { sessionEndUnreported: _flag, ...unflagged } = agyStopEvent(root);
    releaseUnreportedSession(unflagged, { kind: "abstain" });
    assert.equal(coreFacade.presence.checkCollision(root, file, "antigravity-run-2").kind, "ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
