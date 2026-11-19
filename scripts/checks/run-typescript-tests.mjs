import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const source = "packages/editor/tests";
const compiled = "packages/editor/.cache/ts/editor/tests";
// 从源码发现用例，避免测试迁移后 .cache 中的旧文件被再次执行。
const tests = readdirSync(source, { recursive: true })
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => resolve(compiled, file.replace(/\.ts$/, ".js")));

if (tests.length === 0) throw new Error("No TypeScript tests found");
const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
