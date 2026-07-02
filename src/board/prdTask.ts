import { basename, dirname, extname } from "node:path";
import { type BoardStore, type BoardTaskRecord } from "./BoardStore.js";
import { preparePrdInput } from "./prdAssets.js";

export const prdFileBoardTaskTitle = (prdFile: string): string => {
  const file = basename(prdFile, extname(prdFile));
  const label = /^(prd|requirements?|product-requirements?)$/i.test(file)
    ? basename(dirname(prdFile))
    : file;
  return `PRD: ${label}`;
};

export const createPrdFileBoardTask = (
  store: BoardStore,
  input: {
    readonly prdFile: string;
    readonly prd: string;
    readonly title?: string;
    readonly planningOnly?: boolean;
  },
): BoardTaskRecord => {
  const title = input.title ?? prdFileBoardTaskTitle(input.prdFile);
  const task = store.createTask({
    title,
    prompt: "# Product Requirements Document\n\n",
  });
  const prepared = preparePrdInput({
    prdFile: input.prdFile,
    prdText: input.prd,
    taskAssetsDir: store.taskAssetsDir(task.id),
  });
  return (
    store.updateTask(task.id, {
      prompt: `# Product Requirements Document\n\n${prepared.prompt}`,
      source: {
        type: "prd-file",
        prdFile: input.prdFile,
        ...(prepared.assets.length > 0 ? { assets: prepared.assets } : {}),
      },
    }) ?? task
  );
};
