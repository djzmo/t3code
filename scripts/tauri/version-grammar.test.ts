import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NIGHTLY_VERSION_PATTERN,
  STABLE_VERSION_PATTERN,
  type ProductVersionChannel,
  resolveProductVersion,
  resolveProductVersionMetadata,
} from "./resolve-product-version.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("Agent Nanoni product-version grammar", () => {
  it("keeps the stable product seed in the upstream stable grammar", () => {
    const version = resolveProductVersion({ rootDir: repositoryRoot, channel: "stable" });

    expect(version).toBe("1.0.0");
    expect(version).toMatch(STABLE_VERSION_PATTERN);
    expect(version).not.toContain("nanoni");
  });

  it("adds the upstream nightly suffix without a fork suffix", () => {
    const version = resolveProductVersion({
      rootDir: repositoryRoot,
      channel: "nightly",
      date: "20260818",
      run: 42,
    });

    expect(version).toBe("1.0.0-nightly.20260818.42");
    expect(version).toMatch(NIGHTLY_VERSION_PATTERN);
    expect(version).not.toContain("nanoni");
  });

  it("returns the compatible server version from the pinned upstream tag", () => {
    expect(
      resolveProductVersionMetadata({ rootDir: repositoryRoot, channel: "stable" }),
    ).toMatchObject({
      productVersion: "1.0.0",
      compatibleServerVersion: "0.0.34-nightly.20260817.1116",
      upstreamBaseTag: "v0.0.34-nightly.20260817.1116",
      packageSpec: "t3@0.0.34-nightly.20260817.1116",
    });
  });

  it.each([
    ["1.0", "stable"],
    ["1.0.0-nanoni", "stable"],
    ["1.0.0-nightly.20260818", "nightly"],
  ] as const)(
    "rejects a non-upstream %s version seed for %s",
    (productVersion: string, channel: ProductVersionChannel) => {
      expect(() =>
        resolveProductVersion({
          rootDir: repositoryRoot,
          channel,
          productVersion,
          date: "20260818",
          run: 1,
        }),
      ).toThrow();
    },
  );

  it.each([
    ["2026081", 1],
    ["20260818", 0],
    ["20260818", "1.5"],
  ] as const)(
    "rejects malformed nightly metadata date=%s run=%s",
    (date: string, run: number | string) => {
      expect(() =>
        resolveProductVersion({
          rootDir: repositoryRoot,
          channel: "nightly",
          date,
          run,
        }),
      ).toThrow();
    },
  );
});
