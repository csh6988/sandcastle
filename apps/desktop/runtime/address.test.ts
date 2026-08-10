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

  it("keeps the socket inline at exactly the 100-byte limit and falls back one byte over", () => {
    // The in-directory socket suffix "/.sandcastle/runtime/company-runtime.sock"
    // is 41 bytes, so a 59-char Company Directory yields a 100-byte address
    // (inline) and a 60-char one yields 101 bytes (fallback). This pins the
    // `<= 100` comparator at its exact boundary — 100 is the project's
    // conservative threshold, comfortably under the platform `sun_path` limit
    // (104 bytes on darwin), so an over-limit path takes the /tmp fallback
    // rather than risking a truncated or ENAMETOOLONG bind.
    const dirAtLimit = `/${"a".repeat(58)}`;
    const dirOverLimit = `/${"a".repeat(59)}`;
    const atLimit = companyRuntimeAddressForPlatform(dirAtLimit, "darwin");
    const overLimit = companyRuntimeAddressForPlatform(dirOverLimit, "darwin");

    assert.equal(Buffer.byteLength(atLimit), 100);
    assert.equal(
      atLimit,
      `${dirAtLimit}/.sandcastle/runtime/company-runtime.sock`,
    );
    assert.match(
      overLimit,
      /^\/tmp\/sandcastle-company-runtime-[a-f0-9]{20}\.sock$/,
    );
  });

  it("selects the in-directory socket on every non-Windows platform, not just darwin", () => {
    // The named-pipe branch is win32-only; all other platforms share the posix
    // socket branch, so linux must resolve the same in-directory socket.
    assert.equal(
      companyRuntimeAddressForPlatform("/srv/company", "linux"),
      "/srv/company/.sandcastle/runtime/company-runtime.sock",
    );
  });

  it("derives a distinct deterministic address per Company Directory on each platform", () => {
    // Two Company Directories must never collide onto one pipe or one fallback
    // socket, or two companies would fight over a single Runtime endpoint.
    const pipeOne = companyRuntimeAddressForPlatform(
      "C:\\Companies\\one",
      "win32",
    );
    const pipeTwo = companyRuntimeAddressForPlatform(
      "C:\\Companies\\two",
      "win32",
    );
    assert.notEqual(pipeOne, pipeTwo);

    const longOne = `/Users/alice/${"nested-company-directory/".repeat(10)}one`;
    const longTwo = `/Users/alice/${"nested-company-directory/".repeat(10)}two`;
    const sockOne = companyRuntimeAddressForPlatform(longOne, "darwin");
    const sockTwo = companyRuntimeAddressForPlatform(longTwo, "darwin");
    assert.match(
      sockOne,
      /^\/tmp\/sandcastle-company-runtime-[a-f0-9]{20}\.sock$/,
    );
    assert.notEqual(sockOne, sockTwo);
    // Determinism: the same Company Directory always resolves to the same address.
    assert.equal(sockOne, companyRuntimeAddressForPlatform(longOne, "darwin"));
  });
});
