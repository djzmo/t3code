import { assert, describe, it } from "@effect/vitest";

import {
  assertShellHelloVersion,
  checkedInVersionFallback,
  createBootSnapshot,
  resolveVersionMetadata,
} from "./bootSnapshot.ts";

const defines = {
  productVersion: "1.2.3-nightly.20260818.7",
  compatibleServerVersion: "0.0.34-nightly.20260817.1116",
  upstreamBaseTag: "v0.0.34-nightly.20260817.1116",
};

describe("bootSnapshot", () => {
  it("resolves all build-time defines and cross-checks shell.hello", () => {
    const metadata = resolveVersionMetadata({
      defines,
      isDevelopment: false,
      shellHelloVersion: defines.productVersion,
    });

    assert.deepStrictEqual(metadata, defines);
  });

  it("uses the checked-in pin only when a development build has no defines", () => {
    const metadata = resolveVersionMetadata({ defines: {}, isDevelopment: true });

    assert.deepStrictEqual(metadata, checkedInVersionFallback());
    assert.match(metadata.productVersion, /^\d+\.\d+\.\d+$/);
    assert.match(metadata.compatibleServerVersion, /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/);
  });

  it("rejects partial or malformed define sets", () => {
    assert.throws(
      () =>
        resolveVersionMetadata({
          defines: { productVersion: defines.productVersion },
          isDevelopment: true,
        }),
      /compatibleServerVersion must be a non-empty string/,
    );
    assert.throws(
      () =>
        resolveVersionMetadata({
          defines: { ...defines, upstreamBaseTag: "v9.9.9" },
          isDevelopment: false,
        }),
      /does not match compatibleServerVersion/,
    );
  });

  it("rejects a shell version that disagrees with the product build", () => {
    const metadata = resolveVersionMetadata({ defines, isDevelopment: false });

    assert.throws(
      () => assertShellHelloVersion("9.9.9", metadata),
      /does not match Nanoni productVersion/,
    );
  });

  it("merges version metadata into the renderer boot snapshot", () => {
    const snapshot = createBootSnapshot({
      defines,
      isDevelopment: false,
      base: { isDev: true, platform: "win32" },
    });

    assert.deepStrictEqual(snapshot, { ...defines, isDev: true, platform: "win32" });
    assert.isTrue(Object.isFrozen(snapshot));
  });
});
