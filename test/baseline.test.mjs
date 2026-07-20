import assert from "node:assert/strict";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractBaseline, verifyBaseline } from "../benchmark/baseline.mjs";

const archivePath = fileURLToPath(
  new URL("../benchmark/baselines/legacy-code-atlas-0.1.0.tar.gz", import.meta.url),
);
const manifestPath = fileURLToPath(
  new URL("../benchmark/baselines/legacy-code-atlas-0.1.0.manifest.json", import.meta.url),
);
const expectedArchiveSha256 = "49bfc6abfb2026c249541b4bb95e6609dcf959737a6098f8af426bbd54bb5e97";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeManifestVariant(t, mutate) {
  const directory = await temporaryDirectory(t, "legacy-atlas-manifest-");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutate(manifest);
  const variantPath = path.join(directory, "manifest.json");
  await writeFile(variantPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return variantPath;
}

test("verifyBaseline accepts the frozen archive and all declared runtime files", async () => {
  const result = await verifyBaseline({ archivePath, manifestPath });

  assert.equal(result.archiveSha256, expectedArchiveSha256);
  assert.equal(result.fileCount, 14);
});

test("verifyBaseline rejects a tampered archive copy", async (t) => {
  const directory = await temporaryDirectory(t, "legacy-atlas-tampered-");
  const tamperedPath = path.join(directory, "tampered.tar.gz");
  await copyFile(archivePath, tamperedPath);
  await appendFile(tamperedPath, Buffer.from([0]));

  await assert.rejects(
    verifyBaseline({ archivePath: tamperedPath, manifestPath }),
    /archive SHA-256 mismatch/i,
  );
});

test("verifyBaseline rejects a manifest that omits an archived runtime file", async (t) => {
  const variantPath = await writeManifestVariant(t, (manifest) => {
    delete manifest.files["package.json"];
  });

  await assert.rejects(
    verifyBaseline({ archivePath, manifestPath: variantPath }),
    /runtime file set mismatch.*package\.json/i,
  );
});

test("verifyBaseline rejects a manifest that declares an extra runtime file", async (t) => {
  const variantPath = await writeManifestVariant(t, (manifest) => {
    manifest.files["src/not-in-archive.mjs"] = "0".repeat(64);
  });

  await assert.rejects(
    verifyBaseline({ archivePath, manifestPath: variantPath }),
    /runtime file set mismatch.*src\/not-in-archive\.mjs/i,
  );
});

test("verifyBaseline rejects an incorrect runtime file digest", async (t) => {
  const variantPath = await writeManifestVariant(t, (manifest) => {
    manifest.files["src/analyzer.mjs"] = "0".repeat(64);
  });

  await assert.rejects(
    verifyBaseline({ archivePath, manifestPath: variantPath }),
    /runtime file SHA-256 mismatch.*src\/analyzer\.mjs/i,
  );
});

test("verifyBaseline rejects Windows drive-relative and backslash absolute manifest paths", async (t) => {
  for (const unsafePath of ["C:evil.mjs", "C:\\evil.mjs"]) {
    const variantPath = await writeManifestVariant(t, (manifest) => {
      manifest.files[unsafePath] = "0".repeat(64);
    });

    await assert.rejects(
      verifyBaseline({ archivePath, manifestPath: variantPath }),
      /unsafe tar entry path/i,
      unsafePath,
    );
  }
});

test("extractBaseline restores the frozen runtime into a requested directory", async (t) => {
  const parent = await temporaryDirectory(t, "legacy-atlas-extracted-");
  const destination = path.join(parent, "baseline");

  const result = await extractBaseline({ archivePath, destination });

  assert.equal(result, path.resolve(destination));
  assert.match(await readFile(path.join(destination, "package.json"), "utf8"), /"version": "0\.1\.0"/);
  assert.match(await readFile(path.join(destination, "src", "analyzer.mjs"), "utf8"), /analyzeProject/);
});

test("extractBaseline verifies the exact archive bytes it extracts", async (t) => {
  const parent = await temporaryDirectory(t, "legacy-atlas-extract-verified-");
  const mutableArchivePath = path.join(parent, "legacy-code-atlas-0.1.0.tar.gz");
  const destination = path.join(parent, "baseline");
  await copyFile(archivePath, mutableArchivePath);
  await verifyBaseline({ archivePath: mutableArchivePath, manifestPath });
  await appendFile(mutableArchivePath, Buffer.from([0]));

  await assert.rejects(
    extractBaseline({ archivePath: mutableArchivePath, manifestPath, destination }),
    /archive SHA-256 mismatch/i,
  );
  await assert.rejects(access(destination), { code: "ENOENT" });
});

test("extractBaseline rejects an existing destination containing a directory link", async (t) => {
  const parent = await temporaryDirectory(t, "legacy-atlas-extract-link-");
  const destination = path.join(parent, "baseline");
  const external = path.join(parent, "external");
  await mkdir(destination);
  await mkdir(external);
  await symlink(external, path.join(destination, "src"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    extractBaseline({ archivePath, manifestPath, destination }),
    /destination must not exist/i,
  );
  await assert.rejects(access(path.join(external, "analyzer.mjs")), { code: "ENOENT" });
});
