import { describe, expect, it } from "vitest";

import { hasRequiredSmokeReadiness } from "./smoke-test.mjs";

describe("Tauri packaged smoke readiness", () => {
  it("requires backend readiness and the first renderer round-trip", () => {
    expect(hasRequiredSmokeReadiness("AGENT_NANONI_SMOKE backend-ready")).toBe(false);
    expect(hasRequiredSmokeReadiness("AGENT_NANONI_SMOKE first-roundtrip")).toBe(false);
    expect(
      hasRequiredSmokeReadiness(
        "AGENT_NANONI_SMOKE backend-ready\nAGENT_NANONI_SMOKE first-roundtrip",
      ),
    ).toBe(true);
  });
});
