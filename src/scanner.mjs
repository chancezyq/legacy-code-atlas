import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  raceWithAbort,
  resolveConcurrencyOptions,
  runBoundedQueue,
  throwIfAborted,
} from "./concurrency.mjs";

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".legacy-code-atlas",
  ".vscode",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const FILE_TYPES = new Map([
  [".java", ["java", "code"]],
  [".jsp", ["jsp", "markup"]],
  [".jspx", ["jsp", "markup"]],
  [".js", ["javascript", "code"]],
  [".mjs", ["javascript", "code"]],
  [".html", ["html", "markup"]],
  [".htm", ["html", "markup"]],
  [".xml", ["xml", "config"]],
  [".properties", ["properties", "config"]],
  [".sql", ["sql", "data"]],
  [".md", ["markdown", "docs"]],
  [".txt", ["text", "docs"]],
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function comparePath(left, right) {
  return left.path.localeCompare(right.path, "en");
}

function diagnosticCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : "ERR_SCAN_IO";
}

export async function scanProject(projectRoot, options = {}) {
  const { scanConcurrency } = resolveConcurrencyOptions(options);
  const signal = options.signal;
  throwIfAborted(signal);

  const root = path.resolve(projectRoot);
  const maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  const io = {
    readFile: options.io?.readFile ?? readFile,
    readdir: options.io?.readdir ?? readdir,
    stat: options.io?.stat ?? stat,
  };
  let projectIgnores = [];
  try {
    const ignoreContents = await raceWithAbort(
      io.readFile(path.join(root, ".legacy-code-atlasignore"), "utf8"),
      signal,
    );
    projectIgnores = ignoreContents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const ignoreMatchers = [...projectIgnores, ...(options.ignore ?? [])].map(globToRegExp);
  const files = [];
  const skipped = [];
  const diagnostics = [];

  const ignored = (relativePath) => ignoreMatchers.some((matcher) => matcher.test(relativePath));

  async function scanItem(item, enqueue) {
    if (item.kind === "directory") {
      let entries;
      try {
        entries = await io.readdir(item.absolutePath, { withFileTypes: true });
      } catch (error) {
        if (item.path === "") throw error;
        diagnostics.push({
          path: item.path,
          operation: "readdir",
          code: diagnosticCode(error),
          message: "Unable to read directory",
        });
        return;
      }
      throwIfAborted(signal);

      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        const relativePath = toPosix(path.join(item.path, entry.name));
        const absolutePath = path.join(item.absolutePath, entry.name);

        if (entry.isSymbolicLink()) {
          skipped.push({ path: relativePath, reason: "symbolic-link" });
          continue;
        }
        if (entry.isDirectory()) {
          if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name) || ignored(`${relativePath}/`)) continue;
          enqueue({ kind: "directory", path: relativePath, absolutePath });
          continue;
        }
        if (!entry.isFile() || ignored(relativePath)) continue;

        const extension = path.extname(entry.name).toLowerCase();
        const type = FILE_TYPES.get(extension);
        if (!type) {
          skipped.push({ path: relativePath, reason: "unsupported-file-type" });
          continue;
        }
        enqueue({ kind: "file", path: relativePath, absolutePath, type });
      }
      return;
    }

    let metadata;
    try {
      metadata = await io.stat(item.absolutePath);
    } catch (error) {
      diagnostics.push({
        path: item.path,
        operation: "stat",
        code: diagnosticCode(error),
        message: "Unable to read file metadata",
      });
      return;
    }
    throwIfAborted(signal);

    if (metadata.size > maxFileBytes) {
      skipped.push({ path: item.path, reason: "file-too-large", size: metadata.size });
      return;
    }

    files.push({
      path: item.path,
      absolutePath: item.absolutePath,
      language: item.type[0],
      category: item.type[1],
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    });
  }

  await runBoundedQueue(
    [{ kind: "directory", path: "", absolutePath: root }],
    scanItem,
    { concurrency: scanConcurrency, signal },
  );
  files.sort(comparePath);
  skipped.sort(comparePath);
  diagnostics.sort((left, right) => comparePath(left, right)
    || left.operation.localeCompare(right.operation, "en")
    || left.code.localeCompare(right.code, "en"));

  return { root, files, skipped, diagnostics };
}
