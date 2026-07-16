import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(join(desktopRoot, "package.json"), "utf8"),
) as {
  readonly scripts?: Record<string, string>;
  readonly build?: {
    readonly win?: {
      readonly target?: readonly unknown[];
    };
  };
};
const workflow = readFileSync(
  join(
    desktopRoot,
    "..",
    "..",
    ".github",
    "workflows",
    "desktop-company-runtime.yml",
  ),
  "utf8",
);

describe("Windows Desktop packaging contract", () => {
  it("declares an x64 NSIS installer target and separate packaging commands", () => {
    assert.deepEqual(packageJson.build?.win?.target, [
      { target: "nsis", arch: ["x64"] },
    ]);
    assert.match(
      packageJson.scripts?.["dist:unpacked"] ?? "",
      /electron-builder --dir/,
    );
    assert.match(
      packageJson.scripts?.["dist:windows"] ?? "",
      /electron-builder --win nsis --x64/,
    );
  });

  it("keeps Windows artifact verification in the CI contract", () => {
    assert.match(workflow, /name: Package Windows NSIS/);
    assert.match(workflow, /npm run dist:windows/);
    assert.match(workflow, /npm run verify:windows-package/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
    assert.equal(
      existsSync(join(desktopRoot, "scripts", "verify-windows-package.mjs")),
      true,
    );
  });
});
