import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const output = resolve(root, "dist/packages");
const cache = resolve(root, ".tmp/npm-cache");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
mkdirSync(cache, { recursive: true });

run("pnpm", ["run", "build:editor"]);
const protocol = pack("packages/editor-protocol");
const editor = pack("packages/editor");
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  packages: [protocol, editor],
};
writeFileSync(
  resolve(output, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(manifest, null, 2));

function pack(directory) {
  // pnpm rewrites workspace:* to the published sibling version in the tarball.
  const packed = run("pnpm", ["--dir", resolve(root, directory), "pack", "--json",
    "--pack-destination", output], true);
  const tarball = JSON.parse(packed.stdout).filename;
  const result = run("npm", [
    "pack",
    tarball,
    "--dry-run",
    "--json",
    "--pack-destination",
    output,
    "--cache",
    cache,
  ], true);
  const parsed = JSON.parse(result.stdout)[0];
  if (parsed === undefined) throw new Error(`npm pack returned no package for ${directory}`);
  const packageFiles = /^(?:dist\/|src\/|(?:LICENSE|README\.md|THIRD-PARTY-NOTICES\.txt|package\.json)$)/u;
  const appDirectory = /(?:^|\/)(?:apps|demo|benchmarks?)(?:\/|$)/u;
  const unexpected = parsed.files.find((file) => !packageFiles.test(file.path) || appDirectory.test(file.path));
  if (unexpected !== undefined) {
    throw new Error(`Unexpected archive entry in ${directory}: ${unexpected.path}`);
  }
  return {
    name: parsed.name,
    version: parsed.version,
    filename: parsed.filename,
    packedBytes: parsed.size,
    unpackedBytes: parsed.unpackedSize,
    integrity: parsed.integrity,
    files: parsed.entryCount,
  };
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}):\n${result.stderr ?? ""}`,
    );
  }
  return result;
}
