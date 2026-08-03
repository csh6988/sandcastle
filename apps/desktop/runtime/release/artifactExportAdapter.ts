import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactRegistry } from "../artifactRegistry.js";
import type {
  ReleaseOperationEffectAdapter,
  ReleaseOperationEffectRequest,
  ReleaseOperationItemFinalize,
  ReleaseOperationReconcileObservation,
} from "./releaseOperationContracts.js";

type ExportRequest = Extract<ReleaseOperationEffectRequest, { readonly kind: "export" }>;

export interface ArtifactExportAdapterOptions {
  readonly artifacts: Pick<ArtifactRegistry, "inspect" | "verify" | "readContent">;
  readonly now?: () => Date;
  /** Test-only fault injection; production callers must omit this. */
  readonly testOnlyCrashAt?: "after-temp-fsync" | "after-rename" | "before-receipt";
}

type SecureWriteResult =
  | { readonly status: "applied"; readonly digest: string; readonly size: number }
  | { readonly status: "conflict"; readonly observed: unknown }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string };

type SecureObservation =
  | { readonly status: "absent" }
  | { readonly status: "regular"; readonly digest: string; readonly size: number }
  | { readonly status: "conflict"; readonly observed: unknown }
  | { readonly status: "unavailable"; readonly message: string };

class ArtifactExportError extends Error {
  constructor(
    readonly code:
      | "RELEASE_ARTIFACT_NOT_AUTHORIZED"
      | "RELEASE_ARTIFACT_UNREADABLE"
      | "RELEASE_DESTINATION_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactExportError";
  }
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const reservedWindowsName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const assertRelativePath = (value: string): string[] => {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value) ||
    value.startsWith("//") ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new ArtifactExportError(
      "RELEASE_DESTINATION_INVALID",
      "Artifact export destination must be an exact portable relative path.",
    );
  }
  const components = value.split("/");
  if (
    components.some(
      (component) =>
        component.length === 0 ||
        component === "." ||
        component === ".." ||
        component.includes(":") ||
        /[. ]$/.test(component) ||
        reservedWindowsName.test(component),
    )
  ) {
    throw new ArtifactExportError(
      "RELEASE_DESTINATION_INVALID",
      "Artifact export destination contains an unsafe path component.",
    );
  }
  return components;
};

const canonicalRoot = (value: string): string => {
  if (
    !isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
    value.startsWith("\\\\") ||
    value.includes("\u0000")
  ) {
    throw new ArtifactExportError(
      "RELEASE_DESTINATION_INVALID",
      "Artifact export root must be a pre-existing local filesystem directory.",
    );
  }
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(value);
  } catch {
    throw new ArtifactExportError(
      "RELEASE_DESTINATION_INVALID",
      "Artifact export root does not exist.",
    );
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new ArtifactExportError(
      "RELEASE_DESTINATION_INVALID",
      "Artifact export root must be a non-symbolic-link directory.",
    );
  }
  const root = realpathSync(value);
  const rootEntry = lstatSync(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new ArtifactExportError(
      "RELEASE_DESTINATION_INVALID",
      "Artifact export root changed while canonicalizing it.",
    );
  }
  return root;
};

const assertInside = (root: string, components: readonly string[]): void => {
  const target = resolve(root, ...components);
  const pathRelative = relative(root, target);
  if (
    pathRelative === "" ||
    pathRelative === ".." ||
    pathRelative.startsWith(`..${sep}`) ||
    isAbsolute(pathRelative)
  ) {
    throw new ArtifactExportError(
      "RELEASE_DESTINATION_INVALID",
      "Artifact export destination escapes its canonical root.",
    );
  }
};

const descriptorRelativeHelper = String.raw`
import errno, hashlib, inspect, json, os, stat, sys, uuid

config = json.loads(sys.argv[1])
root = config["root"]
components = config["components"]
payload = sys.stdin.buffer.read()

def out(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")))

def unavailable(message):
    out({"status":"unavailable","message":message})
    sys.exit(0)

def capability_ok():
    try:
        parameters = inspect.signature(os.open).parameters
    except (TypeError, ValueError):
        parameters = {}
    return (
        hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY") and
        "dir_fd" in parameters and os.open in getattr(os, "supports_dir_fd", set()) and
        os.stat in getattr(os, "supports_dir_fd", set()) and
        "src_dir_fd" in inspect.signature(os.replace).parameters and
        "dst_dir_fd" in inspect.signature(os.replace).parameters and
        os.link in getattr(os, "supports_dir_fd", set())
    )

if not capability_ok():
    unavailable("Descriptor-relative no-follow filesystem operations are unavailable.")

def identity(metadata):
    return (metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode))

def digest_fd(fd):
    hasher = hashlib.sha256()
    size = 0
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        hasher.update(chunk)
        size += len(chunk)
    return hasher.hexdigest(), size

def leaf_state(parent_fd, leaf):
    try:
        metadata = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return ("absent", None)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        return ("conflict", {"kind":"non-regular-or-symbolic-link"})
    try:
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            return ("conflict", {"kind":"symbolic-link"})
        raise
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or identity(opened) != identity(metadata):
            return ("conflict", {"kind":"leaf-replaced"})
        digest, size = digest_fd(fd)
        after = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        if identity(after) != identity(metadata):
            return ("conflict", {"kind":"leaf-replaced"})
        return ("regular", {"digest":digest,"size":size,"identity":identity(metadata)})
    finally:
        os.close(fd)

descriptors = []
temp_name = None
try:
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptors.append(root_fd)
    root_identity = identity(os.fstat(root_fd))
    ancestor_identities = []
    current = root_fd
    for component in components[:-1]:
        try:
            os.mkdir(component, 0o700, dir_fd=current)
            os.fsync(current)
        except FileExistsError:
            pass
        try:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                out({"status":"invalid","message":"Artifact export ancestor is symbolic-link or not a directory."})
                sys.exit(0)
            raise
        descriptors.append(next_fd)
        ancestor_identities.append((component, identity(os.fstat(next_fd))))
        current = next_fd
    parent_fd = current
    leaf = components[-1]
    pre_kind, pre = leaf_state(parent_fd, leaf)
    if config["overwrite"]["kind"] == "create-only":
        if pre_kind != "absent":
            out({"status":"conflict","observed":pre if pre is not None else {"kind":"present"}})
            sys.exit(0)
    else:
        expected = config["overwrite"]["expectedDestinationDigest"]
        if pre_kind != "regular" or pre["digest"] != expected:
            out({"status":"conflict","observed":pre if pre is not None else {"kind":"absent"}})
            sys.exit(0)

    actual = hashlib.sha256(payload).hexdigest()
    if actual != config["digest"] or len(payload) != config["size"]:
        out({"status":"invalid","message":"Artifact bytes changed after registry verification."})
        sys.exit(0)
    temp_name = ".%s.sandcastle-release-%s.tmp" % (leaf, uuid.uuid4().hex)
    temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(temp_fd, payload[offset:])
        os.fsync(temp_fd)
    finally:
        os.close(temp_fd)
    if config.get("crashAt") == "after-temp-fsync":
        os._exit(81)

    # Re-check the previously observed leaf immediately before the namespace change.
    current_kind, current_state = leaf_state(parent_fd, leaf)
    if config["overwrite"]["kind"] == "create-only":
        if current_kind != "absent":
            os.unlink(temp_name, dir_fd=parent_fd)
            out({"status":"conflict","observed":current_state if current_state is not None else {"kind":"present"}})
            sys.exit(0)
        os.link(temp_name, leaf, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
        os.unlink(temp_name, dir_fd=parent_fd)
        temp_name = None
    else:
        expected = config["overwrite"]["expectedDestinationDigest"]
        if current_kind != "regular" or current_state["digest"] != expected or current_state["identity"] != pre["identity"]:
            os.unlink(temp_name, dir_fd=parent_fd)
            out({"status":"conflict","observed":current_state if current_state is not None else {"kind":"absent"}})
            sys.exit(0)
        os.replace(temp_name, leaf, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temp_name = None
    os.fsync(parent_fd)
    if config.get("crashAt") == "after-rename":
        os._exit(82)

    # A root pathname replacement is not an applied receipt: do not certify an unreachable tree.
    root_after = os.stat(root, follow_symlinks=False)
    if stat.S_ISLNK(root_after.st_mode) or identity(root_after) != root_identity:
        unavailable("Artifact export root changed during the filesystem effect.")
    current_path = root
    for component, expected_identity in ancestor_identities:
        current_path = os.path.join(current_path, component)
        ancestor_after = os.stat(current_path, follow_symlinks=False)
        if (
            stat.S_ISLNK(ancestor_after.st_mode) or
            not stat.S_ISDIR(ancestor_after.st_mode) or
            identity(ancestor_after) != expected_identity
        ):
            unavailable("Artifact export ancestor changed during the filesystem effect.")
    final_kind, final_state = leaf_state(parent_fd, leaf)
    if final_kind != "regular" or final_state["digest"] != actual or final_state["size"] != len(payload):
        unavailable("Artifact export leaf changed during the filesystem effect.")
    if config.get("crashAt") == "before-receipt":
        os._exit(83)
    out({"status":"applied","digest":actual,"size":len(payload)})
except OSError as error:
    if error.errno in (errno.ELOOP, errno.ENOTDIR):
        out({"status":"invalid","message":"Artifact export encountered a symbolic-link path component."})
    elif error.errno == errno.EEXIST:
        out({"status":"conflict","observed":{"kind":"destination-exists"}})
    else:
        unavailable("Artifact export filesystem capability could not prove a safe result.")
finally:
    if temp_name is not None and descriptors:
        try:
            os.unlink(temp_name, dir_fd=descriptors[-1])
        except OSError:
            pass
    for descriptor in reversed(descriptors):
        try:
            os.close(descriptor)
        except OSError:
            pass
`;

const runSecureHelper = (
  input: {
    readonly root: string;
    readonly components: readonly string[];
    readonly overwrite: ExportRequest["item"]["destination"]["overwrite"];
    readonly digest: string;
    readonly size: number;
    readonly crashAt?: ArtifactExportAdapterOptions["testOnlyCrashAt"];
  },
  bytes: Buffer,
): SecureWriteResult => {
  if (process.platform === "win32") {
    return {
      status: "unavailable",
      message: "Descriptor-relative no-follow Artifact export is unavailable on Windows.",
    };
  }
  try {
    const output = execFileSync("python3", ["-c", descriptorRelativeHelper, JSON.stringify(input)], {
      input: bytes,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 128 * 1024,
    }).trim();
    return JSON.parse(output) as SecureWriteResult;
  } catch {
    return {
      status: "unavailable",
      message: "Artifact export stopped before a safe filesystem receipt could be produced.",
    };
  }
};

const runObservationHelper = (
  root: string,
  components: readonly string[],
): SecureObservation => {
  if (process.platform === "win32") {
    return { status: "unavailable", message: "Descriptor-relative observation is unavailable on Windows." };
  }
  /* The write helper with an impossible digest is intentionally not used for observation: it could create parents. */
  const observationScript = String.raw`
import errno, hashlib, inspect, json, os, stat, sys
config=json.loads(sys.argv[1]); root=config["root"]; components=config["components"]
def out(value): sys.stdout.write(json.dumps(value,separators=(",",":")))
try:
  if not hasattr(os,"O_NOFOLLOW") or not hasattr(os,"O_DIRECTORY") or os.open not in getattr(os,"supports_dir_fd",set()) or os.stat not in getattr(os,"supports_dir_fd",set()):
    out({"status":"unavailable","message":"Descriptor-relative no-follow filesystem operations are unavailable."}); sys.exit(0)
  descriptors=[]; current=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); descriptors.append(current)
  for component in components[:-1]:
    try: next_fd=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current)
    except FileNotFoundError: out({"status":"absent"}); sys.exit(0)
    descriptors.append(next_fd); current=next_fd
  leaf=components[-1]
  try: metadata=os.stat(leaf,dir_fd=current,follow_symlinks=False)
  except FileNotFoundError: out({"status":"absent"}); sys.exit(0)
  if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode): out({"status":"conflict","observed":{"kind":"non-regular-or-symbolic-link"}}); sys.exit(0)
  fd=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=current)
  try:
    opened=os.fstat(fd)
    if opened.st_dev != metadata.st_dev or opened.st_ino != metadata.st_ino: out({"status":"conflict","observed":{"kind":"leaf-replaced"}}); sys.exit(0)
    h=hashlib.sha256(); size=0
    while True:
      chunk=os.read(fd,1024*1024)
      if not chunk: break
      h.update(chunk); size+=len(chunk)
    after=os.stat(leaf,dir_fd=current,follow_symlinks=False)
    if after.st_dev != metadata.st_dev or after.st_ino != metadata.st_ino: out({"status":"conflict","observed":{"kind":"leaf-replaced"}}); sys.exit(0)
    out({"status":"regular","digest":h.hexdigest(),"size":size})
  finally: os.close(fd)
except OSError as error:
  if error.errno in (errno.ELOOP,errno.ENOTDIR): out({"status":"conflict","observed":{"kind":"symbolic-link-or-non-directory"}})
  else: out({"status":"unavailable","message":"Filesystem observation could not prove a safe result."})
finally:
  for descriptor in reversed(locals().get("descriptors",[])):
    try: os.close(descriptor)
    except OSError: pass
`;
  try {
    const output = execFileSync("python3", ["-c", observationScript, JSON.stringify({ root, components })], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024,
    }).trim();
    return JSON.parse(output) as SecureObservation;
  } catch {
    return { status: "unavailable", message: "Artifact export destination cannot be safely observed." };
  }
};

const failure = (
  code: ArtifactExportError["code"],
  message: string,
): ReleaseOperationItemFinalize => ({
  state: "failed",
  failure: { code, message, observedAt: new Date().toISOString() },
});

const conflict = (observedDestinationState: unknown): ReleaseOperationItemFinalize => ({
  state: "destination-conflict",
  conflict: {
    code: "RELEASE_DESTINATION_CONFLICT",
    message: "The Artifact export destination does not match its frozen overwrite policy.",
    observedDestinationState,
    observedAt: new Date().toISOString(),
  },
});

const unknown = (message: string): ReleaseOperationItemFinalize => ({
  state: "unknown",
  unknown: {
    code: "RELEASE_DESTINATION_INVALID",
    message,
    observedAt: new Date().toISOString(),
  },
});

export const createArtifactExportAdapter = (
  options: ArtifactExportAdapterOptions,
): ReleaseOperationEffectAdapter => {
  const load = (request: ExportRequest): { readonly root: string; readonly components: string[]; readonly bytes: Buffer } => {
    if (!request.acceptedAuthority.artifactVersionIds.includes(request.item.artifactVersionId)) {
      throw new ArtifactExportError("RELEASE_ARTIFACT_NOT_AUTHORIZED", "Artifact Version is not present in the accepted delivery authority.");
    }
    const inspected = options.artifacts.inspect(request.item.artifactVersionId).version;
    if (
      inspected.id !== request.item.artifactVersionId ||
      inspected.lifecycle !== "finalized" ||
      inspected.contentKind === "external-reference" ||
      inspected.contentKind !== request.artifact.contentKind ||
      inspected.integrityStatus !== "verified" ||
      options.artifacts.verify(inspected.id) !== "verified" ||
      inspected.contentHash !== request.artifact.digest
    ) {
      throw new ArtifactExportError("RELEASE_ARTIFACT_UNREADABLE", "Artifact Version is not a finalized verified managed-file or repository-object with the frozen digest.");
    }
    const bytes = Buffer.from(options.artifacts.readContent(inspected.id));
    if (sha256(bytes) !== request.artifact.digest || bytes.byteLength !== inspected.byteSize) {
      throw new ArtifactExportError("RELEASE_ARTIFACT_UNREADABLE", "Artifact bytes no longer match the frozen Artifact digest and size.");
    }
    const components = assertRelativePath(request.item.destination.relativePath);
    const root = canonicalRoot(request.item.destination.canonicalRoot);
    assertInside(root, components);
    return { root, components, bytes };
  };

  return {
    normalizeCreateRequest(request) {
      if (request.kind !== "export") return request;
      return {
        ...request,
        items: request.items.map((item) => {
          const components = assertRelativePath(item.destination.relativePath);
          const root = canonicalRoot(item.destination.canonicalRoot);
          assertInside(root, components);
          return {
            ...item,
            destination: {
              ...item.destination,
              canonicalRoot: root,
            },
          };
        }),
      };
    },
    async execute(request): Promise<ReleaseOperationItemFinalize> {
      if (request.kind !== "export") return failure("RELEASE_DESTINATION_INVALID", "Artifact export adapter cannot execute a merge Release operation.");
      try {
        const source = load(request);
        const result = runSecureHelper({
          root: source.root,
          components: source.components,
          overwrite: request.item.destination.overwrite,
          digest: request.artifact.digest,
          size: source.bytes.byteLength,
          crashAt: options.testOnlyCrashAt,
        }, source.bytes);
        if (result.status === "applied") {
          return {
            state: "succeeded",
            receipt: {
              kind: "export",
              disposition: "applied",
              destinationDigest: result.digest,
              observedAt: (options.now ?? (() => new Date()))().toISOString(),
            },
          };
        }
        if (result.status === "conflict") return conflict(result.observed);
        if (result.status === "invalid") return failure("RELEASE_DESTINATION_INVALID", result.message);
        return unknown(result.message);
      } catch (error) {
        if (error instanceof ArtifactExportError) return failure(error.code, error.message);
        return failure("RELEASE_ARTIFACT_UNREADABLE", "Artifact content could not be read through the Artifact Registry seam.");
      }
    },

    async reconcile(request, _evidenceRefs): Promise<ReleaseOperationReconcileObservation> {
      if (request.kind !== "export") {
        return { state: "unknown", unknown: { code: "RELEASE_DESTINATION_INVALID", message: "Artifact export adapter cannot reconcile a merge Release operation.", observedAt: new Date().toISOString() } };
      }
      try {
        const source = load(request);
        const observed = runObservationHelper(source.root, source.components);
        const observedAt = (options.now ?? (() => new Date()))().toISOString();
        if (observed.status === "regular" && observed.digest === request.artifact.digest && observed.size === source.bytes.byteLength) {
          return { state: "succeeded", receipt: { kind: "export", disposition: "applied", destinationDigest: observed.digest, observedAt } };
        }
        const unchanged = request.item.destination.overwrite.kind === "create-only"
          ? observed.status === "absent"
          : observed.status === "regular" && observed.digest === request.item.destination.overwrite.expectedDestinationDigest;
        if (unchanged) return { state: "pending" };
        if (observed.status === "conflict" || observed.status === "regular" || observed.status === "absent") {
          return { state: "destination-conflict", conflict: { code: "RELEASE_DESTINATION_CONFLICT", message: "Artifact export destination has drifted from both its frozen pre-state and expected output.", observedDestinationState: observed.status === "conflict" ? observed.observed : { kind: observed.status }, observedAt } };
        }
        return { state: "unknown", unknown: { code: "RELEASE_DESTINATION_INVALID", message: observed.message, observedAt } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Artifact export destination could not be observed.";
        return { state: "unknown", unknown: { code: "RELEASE_DESTINATION_INVALID", message, observedAt: new Date().toISOString() } };
      }
    },
  };
};
