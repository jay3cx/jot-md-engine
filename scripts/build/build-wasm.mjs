import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = "wasm32-unknown-unknown";
const output = resolve(root, process.argv[2]);
// Rust 会把 panic 的文件位置编入 Wasm，发布物只需要可在源码中定位的路径。
const flags = [
  ...(process.env.CARGO_ENCODED_RUSTFLAGS?.split("\x1f") ?? process.env.RUSTFLAGS?.split(/\s+/u) ?? []),
  `--remap-path-prefix=${homedir()}=/build`,
  `--remap-path-prefix=${resolve(root)}=.`,
].filter(Boolean);

execFileSync("cargo", ["build", "--locked", "-p", "editor-wasm", "--target", target, "--release"], {
  cwd: root,
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
  stdio: "inherit",
});
const binary = resolve(root, process.env.CARGO_TARGET_DIR ?? "target", target, "release/editor_wasm.wasm");
execFileSync("wasm-bindgen", [
  binary, "--target", "web", "--out-dir", output, "--out-name", "editor_wasm",
], { cwd: root, stdio: "inherit" });
