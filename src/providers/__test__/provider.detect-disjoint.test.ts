import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resolveProvider } from "../provider.registry.ts";

const PROVIDERS_DIR = join(import.meta.dirname, "..");

// why the real captured fixtures and not hand-built shapes: a disjointness claim is only as good as the payloads it
// is checked against, and these are the ones each host was observed to send.
const FIXTURE_DIRS: readonly { provider: string; dir: string }[] = [
  { provider: "claude", dir: join(PROVIDERS_DIR, "claude", "__test__", "fixtures") },
  { provider: "cursor", dir: join(PROVIDERS_DIR, "cursor", "__test__", "fixtures") },
  { provider: "antigravity", dir: join(PROVIDERS_DIR, "antigravity", "__test__", "fixtures") },
];

function payloadsIn(dir: string): { name: string; payload: unknown }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, payload: JSON.parse(readFileSync(join(dir, name), "utf8")) }));
}

/**
 * invariant: one payload, one provider. Registry order would pick a winner on overlap, so an overlap is not a
 * crash — it is one host's hooks being parsed by another host's adapter, silently.
 */
test("no provider's captured payload is detected by any other provider", () => {
  let checked = 0;
  for (const { provider, dir } of FIXTURE_DIRS) {
    for (const { name, payload } of payloadsIn(dir)) {
      checked += 1;
      const resolved = resolveProvider(payload);
      assert.deepEqual(
        resolved.matchedNames.filter((matched) => matched !== provider),
        [],
        `${provider}/${name} was also detected by ${resolved.matchedNames.join(", ")}`,
      );
      assert.equal(resolved.ambiguous, false, `${provider}/${name} is ambiguous`);
    }
  }
  // why: an empty fixture directory passes the loop above and proves nothing.
  assert.ok(checked >= 40, `expected every provider's fixtures, checked ${checked}`);
});

test("every captured agy payload resolves to antigravity and nothing else", () => {
  const dir = FIXTURE_DIRS.find((entry) => entry.provider === "antigravity")?.dir ?? "";
  for (const { name, payload } of payloadsIn(dir)) {
    assert.deepEqual(resolveProvider(payload).matchedNames, ["antigravity"], name);
  }
});
