export type MarkdownPreviewBlock =
  | {
      readonly type: "heading";
      readonly level: 1 | 2 | 3;
      readonly text: string;
    }
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "list"; readonly items: readonly string[] }
  | { readonly type: "code"; readonly code: string };

export const markdownPreviewBlocks = (
  markdown: string,
): readonly MarkdownPreviewBlock[] => {
  const blocks: MarkdownPreviewBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let codeLines: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: "list", items: listItems });
      listItems = [];
    }
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (codeLines === null) {
        flushParagraph();
        flushList();
        codeLines = [];
      } else {
        blocks.push({ type: "code", code: codeLines.join("\n") });
        codeLines = null;
      }
      continue;
    }

    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!,
      });
      continue;
    }

    if (trimmed.startsWith("- ")) {
      flushParagraph();
      listItems.push(trimmed.slice(2));
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  if (codeLines !== null) {
    blocks.push({ type: "code", code: codeLines.join("\n") });
  }
  flushParagraph();
  flushList();
  return blocks;
};
