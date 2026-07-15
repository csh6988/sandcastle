import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { companyRuntimeAddressForPlatform } from "./address.js";

describe("Company Runtime address", () => {
  it("uses a deterministic Windows Named Pipe", () => {
    const first = companyRuntimeAddressForPlatform(
      "C:\\Users\\alice\\Sandcastle Company",
      "win32",
    );
    const second = companyRuntimeAddressForPlatform(
      "C:\\Users\\alice\\Sandcastle Company",
      "win32",
    );

    assert.equal(first, second);
    assert.match(
      first,
      /^\\\\\.\\pipe\\sandcastle-company-runtime-[a-f0-9]{20}$/,
    );
  });

  it("falls back to a short macOS socket path for a long Company Directory", () => {
    const address = companyRuntimeAddressForPlatform(
      `/Users/alice/${"nested-company-directory/".repeat(10)}`,
      "darwin",
    );

    assert.match(
      address,
      /^\/tmp\/sandcastle-company-runtime-[a-f0-9]{20}\.sock$/,
    );
    assert.ok(Buffer.byteLength(address) <= 100);
  });

  it("keeps the socket inside a short macOS Company Directory", () => {
    assert.equal(
      companyRuntimeAddressForPlatform("/tmp/company", "darwin"),
      "/tmp/company/.sandcastle/runtime/company-runtime.sock",
    );
  });
});
