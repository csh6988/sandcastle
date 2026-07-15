import { createHash } from "node:crypto";

const canonicalValue = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
    .join(",")}}`;
};

export const canonicalPipelineJson = (graph: unknown): string =>
  canonicalValue(graph);

export const pipelineHash = (graph: unknown): string =>
  createHash("sha256").update(canonicalPipelineJson(graph)).digest("hex");
