import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class ElectronTestFixtureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ElectronTestFixtureError";
  }
}

export const applyElectronTestFixtureExitCode = (
  processControl: { readonly exit: (code: number) => unknown },
  exitCode: number,
): void => {
  processControl.exit(exitCode);
};

export type ElectronTestFixtureConfig = {
  readonly schemaVersion: 1;
  readonly configHash: string;
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
  readonly repositoryDirectory: string;
  readonly worktreeDirectory: string;
  readonly repositoryCommit: string;
  readonly rootFingerprint: string;
  readonly cleanupTargets: readonly {
    readonly kind: "repository" | "worktree";
    readonly path: string;
    readonly pathFingerprint: string;
  }[];
  readonly fakeClock: string;
  readonly repeatableIdSeed: string;
};

export interface ElectronTestFixture {
  readonly root: string;
  readonly configPath: string;
  readonly config: ElectronTestFixtureConfig;
  readonly authorization: string;
  readonly authorizationClaimPath: string;
  readonly issueAuthorizationClaim: () => {
    readonly claimId: string;
    readonly authorization: string;
    readonly authorizationClaimPath: string;
  };
  readonly bindTestRunManifestHash: (manifestHash: string) => void;
  readonly cleanupExecutionResources: () => {
    readonly schemaVersion: 1;
    readonly fixtureId: string;
    readonly rootFingerprint: string;
    readonly targets: readonly {
      readonly kind: "repository" | "worktree";
      readonly pathFingerprint: string;
      readonly state: "absent";
    }[];
  };
  readonly cleanup: () => {
    readonly fixtureId: string;
    readonly rootFingerprint: string;
    readonly removed: true;
  };
}

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const configHashFor = (
  config: Omit<ElectronTestFixtureConfig, "configHash">,
): string => sha256(JSON.stringify(canonicalize(config)));

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

const pathWithin = (root: string, target: string): string => {
  const lexicalRoot = resolve(root);
  const canonicalRoot = realpathSync(lexicalRoot);
  const absoluteTarget = resolve(target);
  const relativeTarget = [
    relative(lexicalRoot, absoluteTarget),
    relative(canonicalRoot, absoluteTarget),
  ].find(
    (candidate) =>
      candidate === "" ||
      (candidate !== ".." && !candidate.startsWith(`..${sep}`)),
  );
  if (relativeTarget === undefined) {
    throw new ElectronTestFixtureError(
      "FIXTURE_PATH_ESCAPE",
      `Fixture path ${target} is outside ${canonicalRoot}.`,
    );
  }
  const canonicalTarget = join(canonicalRoot, relativeTarget);
  assertInside(canonicalRoot, canonicalTarget);
  let current = canonicalRoot;
  for (const component of relativeTarget.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) {
      throw new ElectronTestFixtureError(
        "FIXTURE_SYMLINK_FORBIDDEN",
        `Fixture path ${target} contains a symbolic-link component.`,
      );
    }
  }
  return canonicalTarget;
};

const secureReadRegularFile = (input: {
  readonly root: string;
  readonly path: string;
  readonly expectedMode?: number;
  readonly errorCode: string;
  readonly errorMessage: string;
}): { readonly path: string; readonly bytes: Buffer } => {
  if (!isAbsolute(input.path)) {
    throw new ElectronTestFixtureError(input.errorCode, input.errorMessage);
  }
  let path: string;
  try {
    path = pathWithin(input.root, input.path);
  } catch (error) {
    if (error instanceof ElectronTestFixtureError) throw error;
    throw new ElectronTestFixtureError(input.errorCode, input.errorMessage);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      (input.expectedMode !== undefined &&
        (metadata.mode & 0o777) !== input.expectedMode)
    ) {
      throw new ElectronTestFixtureError(input.errorCode, input.errorMessage);
    }
    return { path, bytes: readFileSync(descriptor) };
  } catch (error) {
    if (error instanceof ElectronTestFixtureError) throw error;
    throw new ElectronTestFixtureError(input.errorCode, input.errorMessage);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
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

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const makeWritableForCleanup = (path: string): void => {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) {
      makeWritableForCleanup(join(path, child));
    }
    return;
  }
  chmodSync(path, 0o600);
};

const cleanupPathFingerprint = (path: string): string => {
  if (lstatSync(path).isSymbolicLink()) {
    throw new ElectronTestFixtureError(
      "FIXTURE_CLEANUP_IDENTITY_MISMATCH",
      "Electron Test cleanup targets cannot be symbolic links.",
    );
  }
  const resolved = realpathSync(path);
  const stat = statSync(resolved, { bigint: true });
  return sha256(`${resolved}\n${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
};

const pathEntryExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const claimAuthorization = (
  config: ElectronTestFixtureConfig,
  claimPath: string,
  authorization: string,
  root: string,
): void => {
  assertInside(root, claimPath);
  if (!existsSync(claimPath)) {
    throw new ElectronTestFixtureError(
      "FIXTURE_AUTHORIZATION_ALREADY_CONSUMED",
      "Electron Test fixture authorization was already consumed.",
    );
  }
  if (
    lstatSync(claimPath).isSymbolicLink() ||
    !statSync(claimPath).isFile() ||
    (statSync(claimPath).mode & 0o777) !== 0o600
  ) {
    throw new ElectronTestFixtureError(
      "FIXTURE_CONFIG_INVALID",
      "Electron Test fixture authorization claim must be a 0600 regular non-symlink file.",
    );
  }
  const claimedPath = `${claimPath}.claimed-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(claimPath, claimedPath);
  } catch {
    throw new ElectronTestFixtureError(
      "FIXTURE_AUTHORIZATION_ALREADY_CONSUMED",
      "Electron Test fixture authorization was already consumed.",
    );
  }
  try {
    const claim = JSON.parse(readFileSync(claimedPath, "utf8")) as {
      readonly schemaVersion?: unknown;
      readonly claimId?: unknown;
      readonly configHash?: unknown;
      readonly authorizationHash?: unknown;
    };
    if (
      claim.schemaVersion !== 1 ||
      typeof claim.claimId !== "string" ||
      typeof claim.configHash !== "string" ||
      typeof claim.authorizationHash !== "string" ||
      !secureEqual(claim.configHash, config.configHash) ||
      !secureEqual(claim.authorizationHash, sha256(authorization))
    ) {
      throw new ElectronTestFixtureError(
        "FIXTURE_CONFIG_INVALID",
        "Electron Test fixture authorization claim does not match its frozen hash.",
      );
    }
  } finally {
    unlinkSync(claimedPath);
  }
};

export const loadElectronTestFixtureConfig = (input: {
  readonly configPath: string;
  readonly authorizationClaimPath: string;
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
  const configFile = secureReadRegularFile({
    root: canonicalTempRoot,
    path: input.configPath,
    expectedMode: 0o600,
    errorCode: "FIXTURE_CONFIG_INVALID",
    errorMessage:
      "Electron Test fixture config must be a 0600 regular non-symlink file.",
  });
  const configPath = configFile.path;
  let config: ElectronTestFixtureConfig;
  try {
    config = JSON.parse(
      configFile.bytes.toString("utf8"),
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
    typeof config.configHash !== "string" ||
    typeof config.repositoryDirectory !== "string" ||
    typeof config.worktreeDirectory !== "string" ||
    typeof config.repositoryCommit !== "string"
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
  const companyDirectory = pathWithin(root, config.companyDirectory);
  const evidenceDirectory = pathWithin(root, config.evidenceDirectory);
  const repositoryDirectory = pathWithin(root, config.repositoryDirectory);
  const worktreeDirectory = pathWithin(root, config.worktreeDirectory);
  assertInside(root, companyDirectory);
  assertInside(root, evidenceDirectory);
  assertInside(root, repositoryDirectory);
  assertInside(root, worktreeDirectory);
  assertHash(config.configHash, "fixture config hash");
  const { configHash, ...configInput } = config;
  if (configHashFor(configInput) !== configHash) {
    throw new ElectronTestFixtureError(
      "FIXTURE_CONFIG_INVALID",
      "Electron Test fixture config does not match its immutable hash.",
    );
  }
  if (!/^[a-f0-9]{40}$/.test(config.repositoryCommit)) {
    throw new ElectronTestFixtureError(
      "FIXTURE_CONFIG_INVALID",
      "Electron Test fixture repository commit is invalid.",
    );
  }
  const marker = secureReadRegularFile({
    root: companyDirectory,
    path: join(companyDirectory, ".sandcastle-test-company"),
    errorCode: "FIXTURE_COMPANY_IDENTITY_MISMATCH",
    errorMessage:
      "Electron Test fixture Company Directory marker is not a regular non-symlink file.",
  }).bytes.toString("utf8");
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
    const script = secureReadRegularFile({
      root: canonicalTempRoot,
      path: adapter.scriptPath,
      errorCode: "FIXTURE_SCRIPT_HASH_MISMATCH",
      errorMessage: `Script ${adapter.id} must be a regular non-symlink file.`,
    });
    if (
      sha256(script.bytes) !== adapter.scriptHash ||
      config.scriptHashes[adapter.id] !== adapter.scriptHash
    ) {
      throw new ElectronTestFixtureError(
        "FIXTURE_SCRIPT_HASH_MISMATCH",
        `Script ${adapter.id} does not match its frozen hash.`,
      );
    }
  }
  if (
    git(repositoryDirectory, ["rev-parse", "HEAD"]) !==
      config.repositoryCommit ||
    git(worktreeDirectory, ["rev-parse", "HEAD"]) !== config.repositoryCommit
  ) {
    throw new ElectronTestFixtureError(
      "FIXTURE_REPOSITORY_IDENTITY_MISMATCH",
      "Electron Test fixture Repository and Worktree do not match the frozen commit.",
    );
  }
  claimAuthorization(
    config,
    input.authorizationClaimPath,
    input.authorization,
    root,
  );
  return config;
};

export const readElectronTestFixtureAdapterScript = (
  config: ElectronTestFixtureConfig,
  adapterId: string,
): Buffer => {
  const adapter = config.adapters.find((entry) => entry.id === adapterId);
  if (!adapter || config.scriptHashes[adapterId] !== adapter.scriptHash) {
    throw new ElectronTestFixtureError(
      "FIXTURE_SCRIPT_HASH_MISMATCH",
      `Script ${adapterId} is not frozen by the Electron Test fixture.`,
    );
  }
  const script = secureReadRegularFile({
    root: realpathSync(tmpdir()),
    path: adapter.scriptPath,
    errorCode: "FIXTURE_SCRIPT_HASH_MISMATCH",
    errorMessage: `Script ${adapterId} must be a regular non-symlink file.`,
  });
  if (sha256(script.bytes) !== adapter.scriptHash) {
    throw new ElectronTestFixtureError(
      "FIXTURE_SCRIPT_HASH_MISMATCH",
      `Script ${adapterId} does not match its frozen hash.`,
    );
  }
  return script.bytes;
};

export const verifyTestEvidenceFile = (input: {
  readonly evidenceDirectory: string;
  readonly locator: string;
  readonly contentHash: string;
  readonly byteSize: number;
}): { readonly path: string; readonly bytes: Buffer } => {
  assertHash(input.contentHash, "Test evidence content hash");
  const evidenceDirectory = realpathSync(input.evidenceDirectory);
  const locator = normalizeTestEvidenceLocator(input.locator);
  const verified = secureReadRegularFile({
    root: evidenceDirectory,
    path: join(evidenceDirectory, locator),
    errorCode: "FIXTURE_EVIDENCE_MISMATCH",
    errorMessage:
      "Test evidence locator does not resolve to frozen regular non-symlink bytes.",
  });
  if (
    verified.bytes.byteLength !== input.byteSize ||
    sha256(verified.bytes) !== input.contentHash
  ) {
    throw new ElectronTestFixtureError(
      "FIXTURE_EVIDENCE_MISMATCH",
      "Test evidence locator does not resolve to the frozen bytes, hash, and size.",
    );
  }
  return verified;
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
  const repositoryDirectory = join(root, "repository");
  const worktreeDirectory = join(root, "worktree");
  for (const directory of [
    companyDirectory,
    evidenceDirectory,
    repositoryDirectory,
  ]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  git(repositoryDirectory, ["init", "--initial-branch=fixture-main"]);
  writeFileSync(
    join(repositoryDirectory, "README.md"),
    `# ${input.fixtureId}\n\nTemporary Electron Test fixture Repository.\n`,
    { flag: "wx", mode: 0o600 },
  );
  git(repositoryDirectory, ["add", "README.md"]);
  git(repositoryDirectory, [
    "-c",
    "user.name=Sandcastle Test Fixture",
    "-c",
    "user.email=fixture@sandcastle.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "test: initialize electron fixture repository",
  ]);
  const repositoryCommit = git(repositoryDirectory, ["rev-parse", "HEAD"]);
  git(repositoryDirectory, [
    "worktree",
    "add",
    "--detach",
    worktreeDirectory,
    repositoryCommit,
  ]);
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
  const rootFingerprint = sha256(`${root}\n${marker}`);
  const cleanupTargets = [
    {
      kind: "repository" as const,
      path: repositoryDirectory,
      pathFingerprint: cleanupPathFingerprint(repositoryDirectory),
    },
    {
      kind: "worktree" as const,
      path: worktreeDirectory,
      pathFingerprint: cleanupPathFingerprint(worktreeDirectory),
    },
  ];
  const initialConfig: Omit<ElectronTestFixtureConfig, "configHash"> = {
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
    repositoryDirectory,
    worktreeDirectory,
    repositoryCommit,
    rootFingerprint,
    cleanupTargets,
    fakeClock: input.fakeClock,
    repeatableIdSeed: input.repeatableIdSeed,
  };
  let config: ElectronTestFixtureConfig = {
    ...initialConfig,
    configHash: configHashFor(initialConfig),
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
  let currentClaim: {
    readonly claimId: string;
    readonly authorization: string;
    readonly authorizationClaimPath: string;
  };
  const issueAuthorizationClaim = () => {
    if (currentClaim && existsSync(currentClaim.authorizationClaimPath)) {
      unlinkSync(currentClaim.authorizationClaimPath);
    }
    const claimId = randomBytes(16).toString("hex");
    const authorization = randomBytes(32).toString("hex");
    const authorizationClaimPath = join(root, `authorization-${claimId}.claim`);
    writeFileSync(
      authorizationClaimPath,
      JSON.stringify({
        schemaVersion: 1,
        claimId,
        configHash: config.configHash,
        authorizationHash: sha256(authorization),
      }),
      { flag: "wx", mode: 0o600 },
    );
    chmodSync(authorizationClaimPath, 0o600);
    currentClaim = { claimId, authorization, authorizationClaimPath };
    return currentClaim;
  };
  currentClaim = issueAuthorizationClaim();
  const verifyRoot = (): void => {
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
  };
  return {
    root,
    configPath,
    get authorization() {
      return currentClaim.authorization;
    },
    get authorizationClaimPath() {
      return currentClaim.authorizationClaimPath;
    },
    issueAuthorizationClaim,
    get config() {
      return config;
    },
    bindTestRunManifestHash: (manifestHash) => {
      if (!existsSync(currentClaim.authorizationClaimPath)) {
        throw new ElectronTestFixtureError(
          "FIXTURE_CONFIG_ALREADY_CONSUMED",
          "Electron Test fixture config cannot change after its authorization is consumed.",
        );
      }
      assertHash(manifestHash, "Test Run manifest hash");
      const { configHash: _priorConfigHash, ...priorConfig } = config;
      const nextConfig = { ...priorConfig, testRunManifestHash: manifestHash };
      config = { ...nextConfig, configHash: configHashFor(nextConfig) };
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      issueAuthorizationClaim();
    },
    cleanupExecutionResources: () => {
      verifyRoot();
      for (const target of cleanupTargets) {
        if (!pathEntryExists(target.path)) continue;
        const currentFingerprint = cleanupPathFingerprint(target.path);
        assertInside(root, realpathSync(target.path));
        if (currentFingerprint !== target.pathFingerprint) {
          throw new ElectronTestFixtureError(
            "FIXTURE_CLEANUP_IDENTITY_MISMATCH",
            `Electron Test cleanup refused replaced ${target.kind} resources.`,
          );
        }
        makeWritableForCleanup(target.path);
        rmSync(target.path, { recursive: true, force: false });
        if (existsSync(target.path)) {
          throw new ElectronTestFixtureError(
            "FIXTURE_CLEANUP_INCOMPLETE",
            `Electron Test cleanup did not remove the ${target.kind}.`,
          );
        }
      }
      return {
        schemaVersion: 1,
        fixtureId: input.fixtureId,
        rootFingerprint,
        targets: cleanupTargets.map((target) => ({
          kind: target.kind,
          pathFingerprint: target.pathFingerprint,
          state: "absent" as const,
        })),
      };
    },
    cleanup: () => {
      verifyRoot();
      makeWritableForCleanup(root);
      rmSync(root, { recursive: true, force: false });
      return { fixtureId: input.fixtureId, rootFingerprint, removed: true };
    },
  };
};
