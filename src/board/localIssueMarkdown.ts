export type LocalIssueStatus =
  | "ready-for-agent"
  | "in-progress"
  | "succeeded"
  | "needs-recovery"
  | "needs-verification"
  | "verification-failed"
  | "infra-warning";

const STATUS_LINE = /^status:\s*.*$/im;

export const updateLocalIssueStatusMarkdown = (
  markdown: string,
  status: LocalIssueStatus,
): string => {
  const normalizedLine = `status: ${status}`;
  if (STATUS_LINE.test(markdown)) {
    return markdown.replace(STATUS_LINE, normalizedLine);
  }

  const titleMatch = markdown.match(/^(# .*(?:\r?\n){2})/);
  if (titleMatch?.[1]) {
    return markdown.replace(
      titleMatch[1],
      `${titleMatch[1]}${normalizedLine}\n\n`,
    );
  }

  return `${normalizedLine}\n\n${markdown}`;
};
