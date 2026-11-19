import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageName = process.argv[2];
const packageRoots = {
  "editor-protocol": new URL("../../packages/editor-protocol/dist/", import.meta.url),
  editor: new URL("../../packages/editor/dist/", import.meta.url),
};
const target = packageRoots[packageName];
if (target === undefined) {
  throw new Error(`unknown package build target: ${String(packageName)}`);
}

rmSync(fileURLToPath(target), { recursive: true, force: true });
