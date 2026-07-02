import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const UNSUPPORTED_DOCUMENT_EXTENSIONS = new Set([".doc", ".docx", ".pdf"]);

export const unsupportedPrdDocumentMessage =
  "PDF and Word PRD image extraction is not supported yet. Export images and reference them from a Markdown PRD, or pass an image file directly.";

export interface PrdVisualAsset {
  readonly altText?: string;
  readonly originalReference: string;
  readonly sourcePath: string;
  readonly taskAssetPath: string;
}

export interface PreparedPrdInput {
  readonly prompt: string;
  readonly assets: readonly PrdVisualAsset[];
  readonly warnings: readonly string[];
}

const sanitizeAssetSegment = (value: string): string => {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "asset";
};

export const isPrdVisualAssetFile = (path: string): boolean =>
  IMAGE_EXTENSIONS.has(extname(path).toLowerCase());

export const isUnsupportedPrdDocumentFile = (path: string): boolean =>
  UNSUPPORTED_DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase());

const decodeMarkdownUrlPath = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const markdownImageReferences = (
  markdown: string,
): Array<{ readonly altText: string; readonly reference: string }> => {
  const references: Array<{
    readonly altText: string;
    readonly reference: string;
  }> = [];
  const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(imagePattern)) {
    const reference = match[2]?.trim();
    if (!reference) continue;
    references.push({ altText: match[1] ?? "", reference });
  }
  return references;
};

const taskAssetName = (
  index: number,
  sourcePath: string,
  altText: string | undefined,
): string => {
  const ext = extname(sourcePath).toLowerCase();
  const basis = altText?.trim() || basename(sourcePath, ext) || "asset";
  return `${String(index).padStart(3, "0")}-${sanitizeAssetSegment(basis)}${ext}`;
};

const assetPromptSection = (assets: readonly PrdVisualAsset[]): string => {
  if (assets.length === 0) return "";
  const lines = assets
    .map((asset) => {
      const details = [
        `  - Task asset path: ${asset.taskAssetPath}`,
        `  - Original PRD reference: ${asset.originalReference}`,
        asset.altText ? `  - Alt text: ${asset.altText}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      return `- ${basename(asset.taskAssetPath)}\n${details}`;
    })
    .join("\n\n");
  return `\n\n## PRD visual assets\n\nInspect these image files before planning or implementing frontend work. Treat them as visual product requirements.\n\n${lines}`;
};

export const prdVisualAssetsPromptSection = (
  assets: readonly PrdVisualAsset[],
): string => assetPromptSection(assets);

export const preparePrdInput = (input: {
  readonly prdFile: string;
  readonly prdText: string;
  readonly taskAssetsDir: string;
}): PreparedPrdInput => {
  const warnings: string[] = [];
  const discovered = isPrdVisualAssetFile(input.prdFile)
    ? [
        {
          altText: "PRD visual design",
          reference: input.prdFile,
          sourcePath: input.prdFile,
        },
      ]
    : markdownImageReferences(input.prdText)
        .filter(({ reference }) => isPrdVisualAssetFile(reference))
        .map(({ altText, reference }) => {
          const decoded = decodeMarkdownUrlPath(reference);
          const withoutHash = decoded.split("#", 1)[0] ?? decoded;
          const withoutQuery = withoutHash.split("?", 1)[0] ?? withoutHash;
          const sourcePath = isAbsolute(withoutQuery)
            ? withoutQuery
            : resolve(dirname(input.prdFile), withoutQuery);
          return { altText, reference, sourcePath };
        });

  mkdirSync(input.taskAssetsDir, { recursive: true });
  const assets: PrdVisualAsset[] = [];
  for (const [assetIndex, asset] of discovered.entries()) {
    if (!existsSync(asset.sourcePath)) {
      warnings.push(
        `PRD image asset was not found: ${asset.reference} (${asset.sourcePath})`,
      );
      continue;
    }
    const taskAssetPath = join(
      input.taskAssetsDir,
      taskAssetName(assetIndex + 1, asset.sourcePath, asset.altText),
    );
    copyFileSync(asset.sourcePath, taskAssetPath);
    assets.push({
      ...(asset.altText.trim() ? { altText: asset.altText } : {}),
      originalReference: asset.reference,
      sourcePath: asset.sourcePath,
      taskAssetPath,
    });
  }

  const basePrompt = isPrdVisualAssetFile(input.prdFile)
    ? "The PRD is a visual design asset. Inspect the image listed below and derive the product and frontend requirements from it."
    : input.prdText;

  return {
    prompt: `${basePrompt}${assetPromptSection(assets)}`,
    assets,
    warnings,
  };
};
