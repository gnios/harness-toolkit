import type { ProviderPolicyDefaults } from "../../contracts/index.ts";

// why: empty, not guessed. No agy tool that fetches outside content was captured, and no model slug is known to
// need refusing — a list nobody measured is the kind that goes stale ([/decisions/ad-053.md](/decisions/ad-053.md)).
export function antigravityPolicyDefaults(): ProviderPolicyDefaults {
  return {
    blockedPatterns: [],
    minEffort: null,
    untrustedTools: [],
  };
}
