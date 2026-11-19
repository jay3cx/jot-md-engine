import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/editor/src");

const rules = [
  {
    directory: "components",
    forbidden: ["/hosts/", "/render/"],
    message: "semantic components must not depend on a concrete host",
  },
  {
    directory: "core",
    forbidden: ["/hosts/", "/render/", "/components/"],
    message: "core primitives must not depend on components or hosts",
  },
  {
    directory: "layout",
    forbidden: ["/hosts/", "/render/"],
    message: "layout must not depend on a concrete rendering host",
  },
  {
    directory: "render",
    forbidden: ["/hosts/"],
    message: "shared render runtime must not depend on a concrete host",
  },
  {
    directory: "hosts/live-preview",
    forbidden: ["/hosts/preview/", "/hosts/source/"],
    message: "Live Preview must use host-shared utilities instead of another concrete host",
  },
  {
    directory: "hosts/preview",
    forbidden: ["/hosts/live-preview/", "/hosts/source/"],
    message: "Preview host must not depend on another concrete host",
  },
  {
    directory: "hosts/shared",
    forbidden: ["/hosts/live-preview/", "/hosts/preview/", "/hosts/source/"],
    message: "shared host utilities must not depend on a concrete host",
  },
  {
    directory: "hosts/source",
    forbidden: ["/hosts/live-preview/", "/hosts/preview/"],
    message: "Source host must not depend on another concrete host",
  },
  {
    directory: "component",
    forbiddenRoots: ["input", "render"],
    message: "the public component must use canonical hosts and components",
  },
  {
    directory: "observability",
    forbiddenRoots: ["input", "render"],
    message: "observability must observe canonical contracts",
  },
];

const failures = [];
for (const rule of rules) {
  const directory = join(root, rule.directory);
  for (const file of await sourceFiles(directory)) {
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = normalizeImport(file, specifier);
      const forbiddenSegment = rule.forbidden?.some((segment) => target.includes(segment)) ?? false;
      const forbiddenRoot = rule.forbiddenRoots?.some((directory) =>
        target.startsWith(`/${directory}/`)) ?? false;
      if (forbiddenSegment || forbiddenRoot) {
        failures.push(`${relative(root, file)} -> ${specifier}: ${rule.message}`);
      }
    }
  }
}

if (failures.length > 0) {
  throw new Error(`editor architecture boundary violation:\n${failures.join("\n")}`);
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function importSpecifiers(source) {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/gu)]
    .map((match) => match[1])
    .filter((value) => value !== undefined);
}

function normalizeImport(file, specifier) {
  return `/${relative(root, resolve(dirname(file), specifier)).replaceAll("\\", "/")}/`;
}
