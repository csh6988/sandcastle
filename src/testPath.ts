import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

export const canonicalTestPath = async (path: string): Promise<string> =>
  realpath(path);

export const isTestPathInside = async (
  child: string,
  parent: string,
): Promise<boolean> => {
  const [childPath, parentPath] = await Promise.all([
    canonicalTestPath(child),
    canonicalTestPath(parent),
  ]);
  const rel = relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
