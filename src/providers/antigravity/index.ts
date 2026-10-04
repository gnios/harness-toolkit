import type { ProviderPort } from "../provider.port.ts";
import { antigravityCapabilities } from "./antigravity.capabilities.ts";
import { detectAntigravity } from "./antigravity.detect.ts";
import { antigravityToEvent } from "./antigravity.inbound.ts";
import { renderAntigravityLessonsView } from "./antigravity.lessons-view.ts";
import { antigravityRender } from "./antigravity.outbound.ts";
import { antigravityPolicyDefaults } from "./antigravity.policy-defaults.ts";
import { antigravityWiring, antigravityWiringTargets } from "./antigravity.wiring.ts";

export const antigravityProvider: ProviderPort = {
  name: "antigravity",
  detect: detectAntigravity,
  capabilities: antigravityCapabilities,
  policyDefaults: antigravityPolicyDefaults,
  toEvent: antigravityToEvent,
  render: antigravityRender,
  wiring: antigravityWiring,
  wiringTargets: antigravityWiringTargets,
  lessonsView: renderAntigravityLessonsView,
};
