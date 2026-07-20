import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertGraphEquivalent } from "./baseline.mjs";

const run = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const baselineArchive = path.join(repoRoot, "benchmark", "baselines", "legacy-code-atlas-0.1.0.tar.gz");
const baselineManifest = path.join(repoRoot, "benchmark", "baselines", "legacy-code-atlas-0.1.0.manifest.json");
const baselineHelper = path.join(repoRoot, "benchmark", "baseline.mjs");

export function median(samples) {
  if (!Array.isArray(samples) || samples.length === 0) throw new RangeError("benchmark sample list must not be empty");
  if (samples.some((sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0)) {
    throw new TypeError("benchmark samples must be finite nonnegative numbers");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function speedupRatio(baselineSamples, candidateSamples) {
  const candidate = median(candidateSamples);
  if (candidate <= 0) throw new RangeError("candidate benchmark median must be positive");
  return median(baselineSamples) / candidate;
}

export function assertMinimumSpeedup(baselineSamples, candidateSamples, minimum = 3) {
  if (typeof minimum !== "number" || !Number.isFinite(minimum) || minimum <= 0) {
    throw new TypeError("minimum speedup must be positive");
  }
  const ratio = speedupRatio(baselineSamples, candidateSamples);
  if (ratio < minimum) {
    throw new Error(`candidate benchmark must be at least ${minimum.toFixed(2)}x faster (observed ${ratio.toFixed(2)}x)`);
  }
  return ratio;
}

function sourceFor(index) {
  const chunks = [];
  const actions = [];
  for (let file = 0; file < index; file += 1) {
    chunks.push({
      path: `src/com/acme/generated/Order${file}.java`,
      content: `package com.acme.generated;\npublic class Order${file} { public void save() { getSqlMapClientTemplate().update("order${file}.save${file}", 1); } }\n`,
    });
    chunks.push({
      path: `sqlmap/order${file}.xml`,
      content: `<sqlMap namespace="order${file}"><update id="save${file}">UPDATE dbo.T_ORDER SET STATUS = #status# WHERE ID = #id#</update></sqlMap>\n`,
    });
    chunks.push({
      path: `web/order${file}.jsp`,
      content: `<form action="/order${file}/save.do"><button>Save</button></form>\n`,
    });
    actions.push(`<action path="/order${file}/save" type="com.acme.generated.Order${file}"/>`);
  }
  chunks.push({
    path: "WEB-INF/struts-config.xml",
    content: `<struts-config><action-mappings>${actions.join("")}</action-mappings></struts-config>\n`,
  });
  return chunks;
}

async function createFixture(fileCount) {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-benchmark-"));
  for (const file of sourceFor(fileCount)) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  return root;
}

async function elapsedAnalyze(cli, project, output) {
  const started = process.hrtime.bigint();
  await run(process.execPath, [cli, "analyze", project, "--output", output], { cwd: repoRoot });
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function baselineCli(root) {
  const module = await import(pathToFileURL(baselineHelper));
  const destination = path.join(root, "baseline-runtime");
  await module.extractBaseline({ archivePath: baselineArchive, manifestPath: baselineManifest, destination });
  return path.join(destination, "bin", "legacy-code-atlas.mjs");
}

export async function runBenchmark({ fileCount = 500, samples = 3, minimumSpeedup = 3 } = {}) {
  if (!Number.isSafeInteger(fileCount) || fileCount < 1 || !Number.isSafeInteger(samples) || samples < 1) {
    throw new TypeError("benchmark fileCount and samples must be positive safe integers");
  }
  const project = await createFixture(fileCount);
  const outputRoot = await mkdtemp(path.join(tmpdir(), "legacy-atlas-benchmark-output-"));
  try {
    const candidateCli = path.join(repoRoot, "bin", "legacy-code-atlas.mjs");
    const baseline = await baselineCli(outputRoot);
    const baselineSamples = [];
    const candidateSamples = [];
    let baselineSerialized;
    let candidateSerialized;
    for (let sample = 0; sample < samples; sample += 1) {
      const baselineOutput = path.join(outputRoot, `baseline-${sample}.json`);
      const candidateOutput = path.join(outputRoot, `candidate-${sample}.json`);
      await rm(path.join(project, ".legacy-code-atlas"), { recursive: true, force: true });
      baselineSamples.push(await elapsedAnalyze(baseline, project, baselineOutput));
      await rm(path.join(project, ".legacy-code-atlas"), { recursive: true, force: true });
      candidateSamples.push(await elapsedAnalyze(candidateCli, project, candidateOutput));
      const baselineBytes = await readFile(baselineOutput, "utf8");
      const candidateBytes = await readFile(candidateOutput, "utf8");
      if (sample === 0) {
        baselineSerialized = baselineBytes;
        candidateSerialized = candidateBytes;
        assertGraphEquivalent({ serialized: baselineSerialized }, { serialized: candidateSerialized });
      }
    }
    const ratio = assertMinimumSpeedup(baselineSamples, candidateSamples, minimumSpeedup);
    return { fileCount, samples, baselineSamples, candidateSamples, baselineMedianMs: median(baselineSamples), candidateMedianMs: median(candidateSamples), speedup: ratio };
  } finally {
    await Promise.all([
      rm(project, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true }),
    ]);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const fileCount = Number(process.env.ATLAS_BENCH_FILES ?? 500);
  const samples = Number(process.env.ATLAS_BENCH_SAMPLES ?? 3);
  const minimumSpeedup = Number(process.env.ATLAS_BENCH_MIN_SPEEDUP ?? 3);
  runBenchmark({ fileCount, samples, minimumSpeedup })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`Benchmark failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
