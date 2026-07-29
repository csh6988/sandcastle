import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

export class ElectronTestFixtureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ElectronTestFixtureError";
  }
}

export type ElectronTestFixtureConfig = {
  readonly schemaVersion: 1;
  readonly fixtureId: string;
  readonly testRunId: string;
  readonly testRunManifestHash: string;
  readonly companyDirectory: string;
  readonly companyDirectoryFingerprint: string;
  readonly evidenceDirectory: string;
  readonly adapterIds: readonly string[];
  readonly scriptHashes: Readonly<Record<string, string>>;
  readonly adapters: readonly {
    readonly id: string;
    readonly scriptPath: string;
    readonly scriptHash: string;
  }[];
  readonly ipcToken: string;
  readonly fakeClock: string;
  readonly repeatableIdSeed: string;
};

export interface ElectronTestFixture {
  readonly root: string;
  readonly configPath: string;
  readonly config: ElectronTestFixtureConfig;
  readonly consumeIpcToken: (candidate: string) => void;
  readonly bindTestRunManifestHash: (manifestHash: string) => void;
  readonly cleanup: () => {
    readonly fixtureId: string;
    readonly rootFingerprint: string;
    readonly removed: true;
  };
}

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const secureEqual = (left: string, right: string): boolean => {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
};

const assertHash = (value: string, label: string): void => {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ElectronTestFixtureError(
      "FIXTURE_HASH_INVALID",
      `${label} must be a SHA-256 hash.`,
    );
  }
};

const assertInside = (root: string, target: string): void => {
  const child = relative(root, target);
  if (child === "" || child.startsWith(`..${sep}`) || child === "..") {
    throw new ElectronTestFixtureError(
      "FIXTURE_PATH_ESCAPE",
      `Fixture path ${target} is outside ${root}.`,
    );
  }
};

export const normalizeTestEvidenceLocator = (input: string): string => {
  const portable = input.replaceAll("\\", "/");
  if (
    portable.startsWith("/") ||
    portable.startsWith("//") ||
    /^[A-Za-z]:/.test(portable)
  ) {
    throw new ElectronTestFixtureError(
      "FIXTURE_EVIDENCE_PATH_INVALID",
      "Test evidence locators must be relative portable paths.",
    );
  }
  const parts = portable.split("/").filter((part) => part !== "");
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new ElectronTestFixtureError(
      "FIXTURE_EVIDENCE_PATH_INVALID",
      "Test evidence locators cannot contain traversal or reserved path segments.",
    );
  }
  return parts.join("/");
};

export const deriveElectronTestFixtureRuntimeToken = (
  config: ElectronTestFixtureConfig,
): string => sha256(`sandcastle-electron-test-fixture\n${config.ipcToken}`);

export const loadElectronTestFixtureConfig = (input: {
  readonly configPath: string;
  readonly authorization: string;
  readonly packaged: boolean;
  readonly entrypoint: "electron-test-fixture";
}): ElectronTestFixtureConfig => {
  if (input.packaged || input.entrypoint !== "electron-test-fixture") {
    throw new ElectronTestFixtureError(
      "FIXTURE_MODE_FORBIDDEN",
      "Electron Test fixture mode is unavailable to packaged production builds.",
    );
  }
  const canonicalTempRoot = realpathSync(tmpdir());
  const configPath = realpathSync(input.configPath);
  assertInside(canonicalTempRoot, configPath);
  if (
    lstatSync(input.configPath).isSymbolicLink() ||
    !statSync(configPath).isFile()
  ) {
    throw new ElectronTestFixtureError(
      "FIXTURE_CONFIG_INVALID",
      "Electron Test fixture config must be a regular non-symlink file.",
    );
  }
  if ((statSync(configPath).mode & 0o777) !== 0o600) {
    throw new ElectronTestFixtureError(
      "FIXTURE_CONFIG_PERMISSIONS_INVALID",
      "Electron Test fixture config must be mode 0600.",
    );
  }
  let config: ElectronTestFixtureConfig;
  try {
    config = JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as ElectronTestFixtureConfig;
  } catch {
    throw new ElectronTestFixtureError(
      "FIXTURE_CONFIG_INVALID",
      "Electron Test fixture config is not valid JSON.",
    );
  }
  if (
    config.schemaVersion !== 1 ||
    typeof config.fixtureId !== "string" ||
    typeof config.testRunId !== "string" ||
    typeof config.companyDirectory !== "string" ||
    typeof config.evidenceDirectory !== "string" ||
    !Array.isArray(config.adapters) ||
    config.adapters.length !== 2 ||
    !secureEqual(
      input.authorization,
      deriveElectronTestFixtureRuntimeToken(config),
    )
  ) {
    throw new ElectronTestFixtureError(
      "FIXTURE_CONFIG_INVALID",
      "Electron Test fixture config identity or authorization is invalid.",
    );
  }
  assertHash(config.testRunManifestHash, "Test Run manifest hash");
  assertHash(
    config.companyDirectoryFingerprint,
    "Company Directory fingerprint",
  );
  const root = realpathSync(dirname(configPath));
  const companyDirectory = realpathSync(config.companyDirectory);
  const evidenceDirectory = realpathSync(config.evidenceDirectory);
  assertInside(root, companyDirectory);
  assertInside(root, evidenceDirectory);
  const marker = readFileSync(
    join(companyDirectory, ".sandcastle-test-company"),
    "utf8",
  );
  if (sha256(marker) !== config.companyDirectoryFingerprint) {
    throw new ElectronTestFixtureError(
      "FIXTURE_COMPANY_IDENTITY_MISMATCH",
      "Electron Test fixture Company Directory marker does not match its fingerprint.",
    );
  }
  const allowed = new Set(["scripted-execution", "scripted-interaction"]);
  for (const adapter of config.adapters) {
    if (!allowed.has(adapter.id)) {
      throw new ElectronTestFixtureError(
        "FIXTURE_ADAPTER_FORBIDDEN",
        `Adapter ${adapter.id} is not allowed by the Electron Test fixture entrypoint.`,
      );
    }
    assertHash(adapter.scriptHash, `${adapter.id} script hash`);
    const scriptPath = realpathSync(adapter.scriptPath);
    if (
      lstatSync(adapter.scriptPath).isSymbolicLink() ||
      !statSync(scriptPath).isFile() ||
      sha256(readFileSync(scriptPath)) !== adapter.scriptHash ||
      config.scriptHashes[adapter.id] !== adapter.scriptHash
    ) {
      throw new ElectronTestFixtureError(
        "FIXTURE_SCRIPT_HASH_MISMATCH",
        `Script ${adapter.id} does not match its frozen hash.`,
      );
    }
  }
  return config;
};

export const createElectronTestFixture = (input: {
  readonly fixtureId: string;
  readonly testRunId: string;
  readonly testRunManifestHash: string;
  readonly adapters: readonly {
    readonly id: string;
    readonly scriptPath: string;
    readonly expectedScriptHash: string;
  }[];
  readonly allowedAdapterIds: readonly string[];
  readonly fakeClock: string;
  readonly repeatableIdSeed: string;
  readonly packaged: boolean;
  readonly entrypoint: "electron-test-fixture";
}): ElectronTestFixture => {
  if (input.packaged || input.entrypoint !== "electron-test-fixture") {
    throw new ElectronTestFixtureError(
      "FIXTURE_MODE_FORBIDDEN",
      "Electron Test fixture mode is unavailable to packaged production builds.",
    );
  }
  assertHash(input.testRunManifestHash, "Test Run manifest hash");
  const allowlist = new Set(input.allowedAdapterIds);
  if (
    input.adapters.length !== 2 ||
    input.adapters.some((adapter) => !allowlist.has(adapter.id))
  ) {
    throw new ElectronTestFixtureError(
      "FIXTURE_ADAPTER_FORBIDDEN",
      "The Electron Test fixture requires exactly two allowlisted scripted adapters.",
    );
  }
  const canonicalTempRoot = realpathSync(tmpdir());
  const root = realpathSync(
    mkdtempSync(join(canonicalTempRoot, "sandcastle-test-fixture-")),
  );
  assertInside(canonicalTempRoot, root);
  const companyDirectory = join(root, "company");
  const evidenceDirectory = join(root, "evidence");
  const repositoryDirectory = join(root, "repositories");
  const worktreeDirectory = join(root, "worktrees");
  for (const directory of [
    companyDirectory,
    evidenceDirectory,
    repositoryDirectory,
    worktreeDirectory,
  ]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const marker = JSON.stringify({
    schemaVersion: 1,
    fixtureId: input.fixtureId,
    testRunId: input.testRunId,
  });
  const markerPath = join(companyDirectory, ".sandcastle-test-company");
  writeFileSync(markerPath, marker, { flag: "wx", mode: 0o600 });
  const companyDirectoryFingerprint = sha256(marker);
  const scriptHashes: Record<string, string> = {};
  for (const adapter of input.adapters) {
    const scriptPath = realpathSync(adapter.scriptPath);
    if (
      !statSync(scriptPath).isFile() ||
      lstatSync(scriptPath).isSymbolicLink()
    ) {
      throw new ElectronTestFixtureError(
        "FIXTURE_SCRIPT_INVALID",
        `Script ${adapter.id} must be a regular non-symlink file.`,
      );
    }
    const actualHash = sha256(readFileSync(scriptPath));
    assertHash(adapter.expectedScriptHash, `${adapter.id} script hash`);
    if (actualHash !== adapter.expectedScriptHash) {
      throw new ElectronTestFixtureError(
        "FIXTURE_SCRIPT_HASH_MISMATCH",
        `Script ${adapter.id} does not match its frozen hash.`,
      );
    }
    scriptHashes[adapter.id] = actualHash;
  }
  let config: ElectronTestFixtureConfig = {
    schemaVersion: 1,
    fixtureId: input.fixtureId,
    testRunId: input.testRunId,
    testRunManifestHash: input.testRunManifestHash,
    companyDirectory,
    companyDirectoryFingerprint,
    evidenceDirectory,
    adapterIds: input.adapters.map((adapter) => adapter.id).sort(),
    scriptHashes,
    adapters: input.adapters
      .map((adapter) => ({
        id: adapter.id,
        scriptPath: realpathSync(adapter.scriptPath),
        scriptHash: adapter.expectedScriptHash,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    ipcToken: randomBytes(32).toString("hex"),
    fakeClock: input.fakeClock,
    repeatableIdSeed: input.repeatableIdSeed,
  };
  const configPath = join(root, "fixture.json");
  const descriptor = openSync(configPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(config));
  } finally {
    closeSync(descriptor);
  }
  chmodSync(configPath, 0o600);
  if ((statSync(configPath).mode & 0o777) !== 0o600) {
    throw new ElectronTestFixtureError(
      "FIXTURE_CONFIG_PERMISSIONS_INVALID",
      "Electron Test fixture config must be mode 0600.",
    );
  }
  let tokenConsumed = false;
  const rootFingerprint = sha256(`${root}\n${marker}`);
  return {
    root,
    configPath,
    get config() {
      return config;
    },
    bindTestRunManifestHash: (manifestHash) => {
      if (tokenConsumed) {
        throw new ElectronTestFixtureError(
          "FIXTURE_CONFIG_ALREADY_CONSUMED",
          "Electron Test fixture config cannot change after its IPC token is consumed.",
        );
      }
      assertHash(manifestHash, "Test Run manifest hash");
      config = { ...config, testRunManifestHash: manifestHash };
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    },
    consumeIpcToken: (candidate) => {
      if (tokenConsumed || candidate !== config.ipcToken) {
        throw new ElectronTestFixtureError(
          "FIXTURE_IPC_TOKEN_INVALID",
          "Electron Test fixture IPC token is invalid or already consumed.",
        );
      }
      tokenConsumed = true;
    },
    cleanup: () => {
      const currentRoot = realpathSync(root);
      assertInside(canonicalTempRoot, currentRoot);
      const currentMarker = readFileSync(markerPath, "utf8");
      if (
        sha256(`${currentRoot}\n${currentMarker}`) !== rootFingerprint ||
        sha256(currentMarker) !== companyDirectoryFingerprint
      ) {
        throw new ElectronTestFixtureError(
          "FIXTURE_CLEANUP_IDENTITY_MISMATCH",
          "Electron Test fixture cleanup refused an unrecognized directory.",
        );
      }
      rmSync(currentRoot, { recursive: true, force: false });
      return { fixtureId: input.fixtureId, rootFingerprint, removed: true };
    },
  };
};
