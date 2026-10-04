import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ANTIGRAVITY_HOOK_SET,
  antigravityGlobalHooksPath,
  antigravityWiring,
  antigravityWiringTargets,
  antigravityWorkspaceHooksPath,
  applyAntigravityWiring,
  mergeAntigravityHooks,
  unmergeAntigravityHooks,
} from "../antigravity.wiring.ts";

const RUNTIME = { launcherPath: "/opt/tlc/bin/tlc-exec.mjs" };

// why: the shape the Orca hook really has in ~/.gemini/config/hooks.json on the machine these payloads came from.
const ORCA_STATUS = {
  PreInvocation: [
    { type: "command", command: "ORCA_ANTIGRAVITY_EVENT='PreInvocation' /bin/sh '/x/orca.sh'", timeout: 10 },
  ],
  PostInvocation: [
    { type: "command", command: "ORCA_ANTIGRAVITY_EVENT='PostInvocation' /bin/sh '/x/orca.sh'", timeout: 10 },
  ],
  Stop: [{ type: "command", command: "ORCA_ANTIGRAVITY_EVENT='Stop' /bin/sh '/x/orca.sh'", timeout: 10 }],
};

function entries() {
  return antigravityWiring(RUNTIME).entries;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "agy-wiring-"));
}

test("the global target is under the redirected test home, never the operator's", () => {
  const real = process.env.TLC_TEST_REAL_HOME ?? "";
  assert.ok(real.length > 0);
  assert.equal(antigravityGlobalHooksPath(), join(homedir(), ".gemini", "config", "hooks.json"));
  assert.ok(!antigravityGlobalHooksPath().startsWith(join(real, ".gemini")));
});

test("wiring targets the global hooks file with the named-merge strategy", () => {
  const wiring = antigravityWiring(RUNTIME);
  assert.equal(wiring.target, antigravityGlobalHooksPath());
  assert.equal(wiring.strategy, "named-merge");
});

test("the four verified events are wired, each to its entrypoint", () => {
  assert.deepEqual(
    entries().map((entry) => [entry.hookEvent, entry.handler]),
    [
      ["PreInvocation", "prompt-submit"],
      ["PreToolUse", "tool-before"],
      ["PostToolUse", "tool-after"],
      ["Stop", "stop"],
    ],
  );
});

test("every entry runs the launcher with its handler", () => {
  for (const entry of entries()) {
    assert.equal(entry.command, "node");
    assert.deepEqual(entry.args, [RUNTIME.launcherPath, entry.handler]);
  }
});

test("wiringTargets protects the global file, and the workspace file when a project is named", () => {
  assert.deepEqual(antigravityWiringTargets(), [antigravityGlobalHooksPath()]);
  assert.deepEqual(antigravityWiringTargets("/repo"), [
    antigravityGlobalHooksPath(),
    join("/repo", ".agents", "hooks.json"),
  ]);
  assert.equal(antigravityWorkspaceHooksPath("/repo"), join("/repo", ".agents", "hooks.json"));
});

test("merge into nothing writes only our hook set, in the shape agy reads", () => {
  const result = mergeAntigravityHooks(null, entries());
  assert.ok(result.ok);
  assert.equal(result.changed, true);
  const document = JSON.parse(result.text) as Record<string, Record<string, unknown[]>>;
  assert.deepEqual(Object.keys(document), [ANTIGRAVITY_HOOK_SET]);
  const set = document[ANTIGRAVITY_HOOK_SET] ?? {};
  assert.deepEqual(set.PreInvocation, [
    {
      type: "command",
      command: "TLC_AGY_EVENT=PreInvocation node /opt/tlc/bin/tlc-exec.mjs prompt-submit",
      timeout: 5,
    },
  ]);
  assert.deepEqual(set.PreToolUse, [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: "TLC_AGY_EVENT=PreToolUse node /opt/tlc/bin/tlc-exec.mjs tool-before",
          timeout: 10,
        },
      ],
    },
  ]);
  assert.deepEqual(set.PostToolUse, [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: "TLC_AGY_EVENT=PostToolUse node /opt/tlc/bin/tlc-exec.mjs tool-after",
          timeout: 10,
        },
      ],
    },
  ]);
  assert.deepEqual(set.Stop, [
    { type: "command", command: "TLC_AGY_EVENT=Stop node /opt/tlc/bin/tlc-exec.mjs stop", timeout: 120 },
  ]);
});

test("a launcher path with a space is single-quoted so the shell keeps it one word", () => {
  const result = mergeAntigravityHooks(
    null,
    antigravityWiring({ launcherPath: "/Users/a b/tlc's/tlc-exec.mjs" }).entries,
  );
  assert.ok(result.ok);
  const set = (JSON.parse(result.text) as Record<string, Record<string, { command: string }[]>>)[
    ANTIGRAVITY_HOOK_SET
  ];
  assert.equal(set?.Stop?.[0]?.command, "TLC_AGY_EVENT=Stop node '/Users/a b/tlc'\\''s/tlc-exec.mjs' stop");
});

test("merge preserves a foreign hook set exactly, and its position", () => {
  const existing = `${JSON.stringify({ "orca-status": ORCA_STATUS }, null, 2)}\n`;
  const result = mergeAntigravityHooks(existing, entries());
  assert.ok(result.ok);
  assert.equal(result.changed, true);
  const document = JSON.parse(result.text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(document), ["orca-status", ANTIGRAVITY_HOOK_SET]);
  assert.deepEqual(document["orca-status"], ORCA_STATUS);
});

test("merging the same wiring twice is a no-op", () => {
  const first = mergeAntigravityHooks(JSON.stringify({ "orca-status": ORCA_STATUS }), entries());
  assert.ok(first.ok);
  const second = mergeAntigravityHooks(first.text, entries());
  assert.ok(second.ok);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

// hazard: appending only what is missing leaves the old copy behind when the launcher moves, and every hook then
// fires twice. Our set is replaced whole.
test("a stale harness set from another launcher is replaced, not duplicated", () => {
  const stale = mergeAntigravityHooks(null, antigravityWiring({ launcherPath: "/old/tlc-exec.mjs" }).entries);
  assert.ok(stale.ok);
  const result = mergeAntigravityHooks(stale.text, entries());
  assert.ok(result.ok);
  assert.equal(result.changed, true);
  assert.doesNotMatch(result.text, /\/old\//);
});

test("an enabled flag the operator set on our hook set is not a change", () => {
  const first = mergeAntigravityHooks(null, entries());
  assert.ok(first.ok);
  const document = JSON.parse(first.text) as Record<string, Record<string, unknown>>;
  const set = document[ANTIGRAVITY_HOOK_SET] ?? {};
  const withFlag = { [ANTIGRAVITY_HOOK_SET]: { enabled: false, ...set } };
  const second = mergeAntigravityHooks(JSON.stringify(withFlag), entries());
  assert.ok(second.ok);
  assert.equal(second.changed, false);
  const kept = (JSON.parse(second.text) as Record<string, Record<string, unknown>>)[ANTIGRAVITY_HOOK_SET];
  assert.equal(kept?.enabled, false);
});

test("malformed JSON is refused with the parse error, never overwritten", () => {
  const result = mergeAntigravityHooks("{ not json", entries());
  assert.equal(result.ok, false);
});

test("a JSON array root is refused", () => {
  assert.equal(mergeAntigravityHooks("[]", entries()).ok, false);
});

test("applyAntigravityWiring creates the file and its directory, then is idempotent on disk", () => {
  const root = scratch();
  try {
    const target = join(root, "config", "hooks.json");
    const first = applyAntigravityWiring(target, entries());
    assert.ok(first.ok && first.changed);
    const written = readFileSync(target, "utf8");
    const second = applyAntigravityWiring(target, entries());
    assert.ok(second.ok);
    assert.equal(second.changed, false);
    assert.equal(readFileSync(target, "utf8"), written);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyAntigravityWiring keeps orca-status on disk", () => {
  const root = scratch();
  try {
    const target = join(root, "hooks.json");
    writeFileSync(target, JSON.stringify({ "orca-status": ORCA_STATUS }, null, 2));
    applyAntigravityWiring(target, entries());
    const document = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    assert.deepEqual(document["orca-status"], ORCA_STATUS);
    assert.ok(ANTIGRAVITY_HOOK_SET in document);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyAntigravityWiring on a malformed file writes nothing", () => {
  const root = scratch();
  try {
    const target = join(root, "hooks.json");
    writeFileSync(target, "{ broken");
    const result = applyAntigravityWiring(target, entries());
    assert.equal(result.ok, false);
    assert.equal(readFileSync(target, "utf8"), "{ broken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unmerge drops only our hook set and keeps orca-status", () => {
  const merged = mergeAntigravityHooks(JSON.stringify({ "orca-status": ORCA_STATUS }), entries());
  assert.ok(merged.ok);
  const result = unmergeAntigravityHooks(merged.text);
  assert.equal(result.kind, "rewritten");
  assert.deepEqual(JSON.parse(result.kind === "rewritten" ? result.text : "{}"), {
    "orca-status": ORCA_STATUS,
  });
});

test("unmerge of a file that held only our set reports it empty", () => {
  const merged = mergeAntigravityHooks(null, entries());
  assert.ok(merged.ok);
  assert.equal(unmergeAntigravityHooks(merged.text).kind, "empty");
});

test("unmerge with nothing of ours is unchanged, and an absent or broken file is reported as such", () => {
  assert.equal(unmergeAntigravityHooks(JSON.stringify({ "orca-status": ORCA_STATUS })).kind, "unchanged");
  assert.equal(unmergeAntigravityHooks(null).kind, "absent");
  assert.equal(unmergeAntigravityHooks("{ broken").kind, "unparsed");
});

test("nothing in this file wrote under the operator's real ~/.gemini", () => {
  const real = process.env.TLC_TEST_REAL_HOME ?? "";
  assert.notEqual(homedir(), real);
  const marker = join(real, ".gemini", "config", "hooks.json");
  if (existsSync(marker)) {
    assert.doesNotMatch(readFileSync(marker, "utf8"), /\/opt\/tlc\/bin\/tlc-exec\.mjs/);
  }
});
