import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeFileAtomic } from "../src/atomic-write.mjs";

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("atomic write creates parent directories and preserves exact bytes", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, "nested", "index.json");
  const content = Buffer.from([0, 1, 2, 255]);

  await writeFileAtomic(target, content);

  assert.deepEqual(await readFile(target), content);
  assert.deepEqual(await readdir(path.dirname(target)), ["index.json"]);
});

test("atomic write replaces an existing target without leaving temporary files", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, "index.json");
  await writeFile(target, "old\n");

  await writeFileAtomic(target, "new\n");

  assert.equal(await readFile(target, "utf8"), "new\n");
  assert.deepEqual(await readdir(root), ["index.json"]);
});

test("atomic write preserves an existing target mode unless explicitly overridden", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, "index.json");
  await writeFile(target, "old\n", { mode: 0o600 });

  await writeFileAtomic(target, "new\n");

  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await writeFileAtomic(target, "explicit\n", { mode: 0o640 });
  assert.equal((await stat(target)).mode & 0o777, 0o640);
});

test("atomic write keeps the old target and cleans up when rename fails", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, "index.json");
  await writeFile(target, "old\n");
  const failingFs = {
    ...fsPromises,
    rename: async () => { throw new Error("rename failed"); },
  };

  await assert.rejects(
    writeFileAtomic(target, "new\n", { io: failingFs }),
    /rename failed/,
  );

  assert.equal(await readFile(target, "utf8"), "old\n");
  assert.deepEqual(await readdir(root), ["index.json"]);
});

test("atomic write honors an already-aborted signal before opening a temp file", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, "index.json");
  await writeFile(target, "old\n");
  const controller = new AbortController();
  controller.abort();
  const io = {
    ...fsPromises,
    open: async () => { throw new Error("open must not run"); },
  };

  await assert.rejects(
    writeFileAtomic(target, "new\n", { io, signal: controller.signal }),
    (error) => error.name === "AbortError",
  );
  assert.equal(await readFile(target, "utf8"), "old\n");
  assert.deepEqual(await readdir(root), ["index.json"]);
});

test("atomic write retries transient Windows rename failures", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, "index.json");
  let attempts = 0;
  const io = {
    ...fsPromises,
    async rename(...args) {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("temporarily locked");
        error.code = attempts === 1 ? "EBUSY" : "EPERM";
        throw error;
      }
      return fsPromises.rename(...args);
    },
  };

  await writeFileAtomic(target, "new\n", { io, retryDelayMs: 0 });

  assert.equal(attempts, 3);
  assert.equal(await readFile(target, "utf8"), "new\n");
});

test("atomic write bounds temporary basename length", async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, `${"x".repeat(200)}.json`);

  await writeFileAtomic(target, "new\n");

  assert.equal(await readFile(target, "utf8"), "new\n");
});

test("atomic write uses exclusive open and flushes before close and rename", async () => {
  const calls = [];
  const io = {
    async mkdir() { calls.push("mkdir"); },
    async open(_temporary, flags, mode) {
      calls.push(`open:${flags}:${mode.toString(8)}`);
      return {
        async writeFile(value) { calls.push(`write:${value}`); },
        async sync() { calls.push("sync"); },
        async close() { calls.push("close"); },
      };
    },
    async rename() { calls.push("rename"); },
    async rm() { calls.push("rm"); },
  };

  await writeFileAtomic("index.json", "data", { io, mode: 0o666 });

  assert.deepEqual(calls, ["mkdir", "open:wx:666", "write:data", "sync", "close", "rename"]);
});

test("atomic write cleans temporary files after each pre-rename failure", async (t) => {
  for (const failingStage of ["open", "write", "sync", "close"]) {
    await t.test(failingStage, async () => {
      const root = await mkdtemp(path.join(tmpdir(), `legacy-atlas-atomic-${failingStage}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      const target = path.join(root, "index.json");
      await writeFile(target, "old\n");
      const io = {
        ...fsPromises,
        async open(...args) {
          if (failingStage === "open") throw new Error("open failed");
          const handle = await fsPromises.open(...args);
          let closeCalls = 0;
          return {
            async writeFile(...writeArgs) {
              if (failingStage === "write") throw new Error("write failed");
              return handle.writeFile(...writeArgs);
            },
            async sync() {
              if (failingStage === "sync") throw new Error("sync failed");
              return handle.sync();
            },
            async close() {
              closeCalls += 1;
              await handle.close();
              if (failingStage === "close" && closeCalls === 1) throw new Error("close failed");
            },
          };
        },
      };

      await assert.rejects(
        writeFileAtomic(target, "new\n", { io }),
        new RegExp(`${failingStage} failed`),
      );
      assert.equal(await readFile(target, "utf8"), "old\n");
      assert.deepEqual(await readdir(root), ["index.json"]);
    });
  }
});
