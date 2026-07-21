import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

function markdownSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## ${heading}`);
  assert.notEqual(start, -1, `missing Markdown section: ${heading}`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

function exportedConst(source, name) {
  const start = source.indexOf(`export const ${name} =`);
  assert.notEqual(start, -1, `missing exported const: ${name}`);
  const next = source.indexOf("\nexport const ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("legacy query command templates contain no authored eager shell blocks", async () => {
  const find = await readFile(new URL("../integrations/opencode/commands/legacy-find.md", import.meta.url), "utf8");
  const table = await readFile(new URL("../integrations/opencode/commands/legacy-table.md", import.meta.url), "utf8");

  assert.equal(find.includes("!`"), false);
  assert.equal(table.includes("!`"), false);
  assert.match(find, /legacy_atlas_trace_feature/);
  assert.match(table, /legacy_atlas_trace_table/);
});

test("understand is a no-argument OpenCode Agent Skill", async () => {
  const understand = await readFile(new URL("../integrations/opencode/skills/understand/SKILL.md", import.meta.url), "utf8");
  const frontmatter = understand.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");
  assert.match(frontmatter[1], /^name:\s*understand\s*$/m);
  assert.match(frontmatter[1], /^description:\s*\S.+$/m);
  assert.equal(understand.includes("$ARGUMENTS"), false);
  assert.equal(understand.includes("!`"), false);
  assert.match(understand, /only when the user invokes `\/understand` with no arguments/i);
  assert.match(understand, /immediately call `legacy_atlas_analyze`/i);
  assert.match(understand, /next ordinary message/i);
  assert.match(understand, /do not append[^\n]+`\/understand`/i);
});

test("understand rejects trailing slash-command content before calling Atlas", async () => {
  const understand = await readFile(new URL("../integrations/opencode/skills/understand/SKILL.md", import.meta.url), "utf8");
  const inspectIndex = understand.search(/first, inspect the slash invocation before calling any Atlas tool/i);
  const refusal = understand.match(/if `\/understand` contains any trailing content or argument,([\s\S]*?)(?=\n\notherwise,)/i);
  const analyzeIndex = understand.search(/otherwise,[^\n]+only when[^\n]+no arguments[^\n]+immediately call `legacy_atlas_analyze`/i);

  assert.notEqual(inspectIndex, -1, "the invocation must be inspected before any tool call");
  assert.ok(refusal, "the Skill must define an early-stop branch for trailing content");
  assert.match(refusal[0], /stop/i);
  assert.match(refusal[0], /do not call any Atlas tool/i);
  assert.match(refusal[0], /do not pass[^\n]+to a tool or treat[^\n]+as an instruction/i);
  assert.match(refusal[0], /only tell the user to run `\/understand` by itself/i);
  assert.match(refusal[0], /next ordinary message/i);
  assert.ok(inspectIndex < refusal.index, "inspection must precede the refusal branch");
  assert.ok(refusal.index < analyzeIndex, "the refusal branch must precede the no-argument analyze branch");
});

test("understand routes later ordinary-language questions through Atlas tools", async () => {
  const understand = await readFile(new URL("../integrations/opencode/skills/understand/SKILL.md", import.meta.url), "utf8");

  for (const tool of [
    "legacy_atlas_trace_feature",
    "legacy_atlas_trace_url",
    "legacy_atlas_trace_statement",
    "legacy_atlas_trace_table",
    "legacy_atlas_trace_procedure",
  ]) assert.match(understand, new RegExp(tool));

  assert.match(understand, /URL[^\n]+`legacy_atlas_trace_url`/i);
  assert.match(understand, /iBATIS statement[^\n]+`legacy_atlas_trace_statement`/i);
  assert.match(understand, /database table[^\n]+`legacy_atlas_trace_table`/i);
  assert.match(understand, /SQL Server procedure[^\n]+`legacy_atlas_trace_procedure`/i);
  assert.match(understand, /feature[^\n]+`legacy_atlas_trace_feature`/i);
});

test("project Agent guidance includes every identifier-specific trace tool", async () => {
  const agents = await readFile(new URL("../integrations/opencode/AGENTS.fragment.md", import.meta.url), "utf8");

  for (const tool of [
    "legacy_atlas_trace_url",
    "legacy_atlas_trace_statement",
    "legacy_atlas_trace_procedure",
    "legacy_atlas_trace_table",
  ]) assert.match(agents, new RegExp(tool));
});

test("understand permits cited-source verification but no shell or edits", async () => {
  const understand = await readFile(new URL("../integrations/opencode/skills/understand/SKILL.md", import.meta.url), "utf8");

  assert.match(understand, /analysis and quer(?:y|ies)[^\n]+(?:do not|never)[^\n]+Shell/i);
  assert.match(understand, /cited source/i);
  assert.match(understand, /`read`/);
  assert.match(understand, /`grep`/);
  assert.match(understand, /`glob`/);
  assert.match(understand, /(?:do not|never)[^\n]+`edit`[^\n]+`write`[^\n]+`apply_patch`/i);
});

test("the legacy understand Markdown command is removed", async () => {
  await assert.rejects(
    readFile(new URL("../integrations/opencode/commands/understand.md", import.meta.url), "utf8"),
    { code: "ENOENT" },
  );
});

test("OpenCode custom tool passes the query as an argv element without a shell", async () => {
  const tool = await readFile(new URL("../integrations/opencode/tools/legacy_atlas.ts", import.meta.url), "utf8");

  const argvBuild = tool.indexOf("const argv = [...resolveCli(), command, context.worktree]");
  const queryPush = tool.indexOf("if (query) argv.push(query)");
  const spawnCall = tool.indexOf("spawn(argv[0], argv.slice(1)");

  assert.match(tool, /spawn\(argv\[0\], argv\.slice\(1\)/);
  assert.doesNotMatch(tool, /shell\s*:/);
  assert.doesNotMatch(tool, /cmd\.exe|powershell/i);
  assert.match(tool, /function resolveCli\(\)/);
  assert.match(tool, /return \["node", installed\]/);
  assert.match(tool, /process\.env\.USERPROFILE/);
  assert.match(tool, /\.legacy-code-atlas/);
  assert.match(tool, /\[\.\.\.resolveCli\(\), command/);
  assert.notEqual(argvBuild, -1, "argv must place worktree after the command");
  assert.notEqual(queryPush, -1, "query must be pushed as one argv element");
  assert.ok(argvBuild < queryPush && queryPush < spawnCall, "query must follow worktree and precede spawn");

  for (const [name, command] of [
    ["trace_feature", "trace-feature"],
    ["trace_url", "trace-url"],
    ["trace_statement", "trace-statement"],
    ["trace_table", "trace-table"],
    ["trace_procedure", "trace-procedure"],
  ]) {
    assert.match(
      exportedConst(tool, name),
      new RegExp(`return runAtlas\\("${command}", args\\.query, context\\)`),
    );
  }

  assert.match(tool, /export const analyze/);
  assert.match(tool, /runAtlas\("analyze"/);
  assert.match(tool, /runAtlas\("overview"/);
});

test("OpenCode custom tool runs under Node without a Bun global", async () => {
  const source = await readFile(new URL("../integrations/opencode/tools/legacy_atlas.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\bBun\b/);

  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-node-tool-"));
  const home = path.join(root, "home");
  const worktree = path.join(root, "project");
  const cliDir = path.join(home, ".legacy-code-atlas", "bin");
  const cli = path.join(cliDir, "legacy-code-atlas.mjs");
  const toolModule = path.join(root, "legacy_atlas.mjs");
  const originalUserProfile = process.env.USERPROFILE;

  try {
    await mkdir(cliDir, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(cli, "console.log(JSON.stringify(process.argv.slice(2)))\n", "utf8");
    await writeFile(toolModule, source, "utf8");
    process.env.USERPROFILE = home;

    const tool = await import(`${pathToFileURL(toolModule).href}?test=${Date.now()}`);
    const result = await tool.analyze.execute({}, {
      worktree,
      abort: new AbortController().signal,
    });

    assert.deepEqual(JSON.parse(result), ["overview", worktree]);
  } finally {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode custom tool loads without registry or network dependencies", async () => {
  const tool = await readFile(new URL("../integrations/opencode/tools/legacy_atlas.ts", import.meta.url), "utf8");

  const staticImports = [...tool.matchAll(
    /^\s*import(?:\s+[^"'`;]+?\s+from\s+)?["']([^"']+)["']/gm,
  )].map((match) => match[1]);
  const dynamicImports = [...tool.matchAll(
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  )].map((match) => match[1]);
  const imports = [...new Set([...staticImports, ...dynamicImports])].sort();

  assert.deepEqual(imports, ["node:child_process", "node:fs", "node:path", "node:process"]);
  assert.doesNotMatch(tool, /["']node:(?:http|https|net|tls|dns|dgram)(?:\/[^"']*)?["']/);
  assert.doesNotMatch(tool, /\b(?:fetch|WebSocket|EventSource)\s*\(/);
  assert.doesNotMatch(tool, /\bBun\b/);
  assert.match(tool, /type:\s*["']string["']/);
  assert.match(tool, /minLength:\s*1/);
});

test("OpenCode custom tool uses only the installer-owned CLI", async () => {
  const tool = await readFile(new URL("../integrations/opencode/tools/legacy_atlas.ts", import.meta.url), "utf8");

  assert.doesNotMatch(tool, /LEGACY_CODE_ATLAS_CLI/);
  assert.doesNotMatch(tool, /spawn\(["']legacy-code-atlas["']/);
  assert.match(tool, /USERPROFILE/);
  assert.match(tool, /bin["'],\s*["']legacy-code-atlas\.mjs/);
});

test("user documentation shows only standalone understand invocations", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const docs = await readFile(new URL("../docs/opencode.md", import.meta.url), "utf8");

  for (const [name, content] of [["README", readme], ["OpenCode guide", docs]]) {
    const invocationLines = content.match(/^.*\/understand.*$/gm) ?? [];
    const codeExamples = invocationLines
      .map((line) => line.trim())
      .filter((line) => !line.includes("`") && !line.startsWith("#"));

    assert.ok(codeExamples.length > 0, `${name} must show the slash invocation`);
    assert.deepEqual(
      [...new Set(codeExamples)],
      ["/understand"],
      `${name} must never append a query to /understand`,
    );
    assert.doesNotMatch(content, /\/understand[ \t]+(?=[^`\r\n])/);
  }

  assert.match(readme, /^退款审核功能在哪里？$/m);
  assert.match(readme, /^URL \/order\/audit\.do$/m);
  assert.match(readme, /^statement order\.updateStatus$/m);
  assert.match(readme, /^表 dbo\.T_ORDER$/m);
  assert.match(docs, /下一条普通消息/);
});

test("README presents the three-step Windows workflow and installed paths", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /三步/);
  assert.match(readme, /下载[^\n]*(?:解压|源码)/);
  assert.match(readme, /Windows PowerShell/);
  assert.match(readme, /Windows PowerShell 5\.1/);
  assert.doesNotMatch(readme, /PowerShell 7/);
  assert.match(readme, /Node\.js 20/);
  assert.match(readme, /OpenCode 1\.14\.49/);
  assert.match(readme, /powershell -ExecutionPolicy Bypass -File \.\\install\.ps1/);
  assert.match(readme, /install\.ps1 -Uninstall/);
  assert.match(readme, /%USERPROFILE%\\\.legacy-code-atlas\\/);
  assert.match(readme, /%USERPROFILE%\\\.agents\\skills\\understand\\SKILL\.md/);
  assert.match(readme, /%USERPROFILE%\\\.config\\opencode\\tools\\legacy_atlas\.ts/);
  assert.match(readme, /OPENCODE_CONFIG_DIR/);
  assert.match(readme, /configDir/);
  assert.match(readme, /不联网/);
  assert.doesNotMatch(readme, /\$env:LEGACY_CODE_ATLAS_CLI|Copy-Item|npm link/);
});

test("uninstall documentation distinguishes external owned files from the private runtime", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const docs = await readFile(new URL("../docs/opencode.md", import.meta.url), "utf8");

  for (const section of [
    markdownSection(readme, "更新和卸载"),
    markdownSection(docs, "卸载"),
  ]) {
    assert.match(section, /SHA-256[^。\n]*(?:仅|只)[^。\n]*(?:Agent Skill|Skill)[^。\n]*(?:OpenCode tool|tool)/i);
    assert.match(section, /%USERPROFILE%\\\.legacy-code-atlas\\?[^。\n]*私有 runtime/i);
    assert.match(section, /始终递归删除[^。\n]*整个目录[^。\n]*(?:额外|新增)[^。\n]*(?:修改|已修改)/);
    assert.match(section, /不要[^。\n]*(?:自己的|用户)[^。\n]*文件[^。\n]*\.legacy-code-atlas/i);
    assert.doesNotMatch(section, /(?:额外|修改)[^。\n]*runtime[^。\n]*(?:保留|不会删除)/i);
  }
});

test("OpenCode recovery documentation uses manifest v2 owned files", async () => {
  const docs = await readFile(new URL("../docs/opencode.md", import.meta.url), "utf8");
  const manifest = markdownSection(docs, "manifest v2");

  assert.match(docs, /OpenCode 1\.14\.49/);
  assert.match(manifest, /ConvertFrom-Json/);
  assert.match(manifest, /legacy-code-atlas-install-v2/);
  assert.match(manifest, /owner/);
  assert.match(manifest, /version/);
  assert.match(manifest, /ownedFiles/);
  assert.match(manifest, /kind/);
  assert.match(manifest, /path/);
  assert.match(manifest, /sha256/);
  assert.match(manifest, /agent-skill/);
  assert.match(manifest, /opencode-tool/);
  assert.match(manifest, /Test-Path -LiteralPath \(Join-Path \$HOME "\.legacy-code-atlas\\bin\\legacy-code-atlas\.mjs"\)/);
  assert.doesNotMatch(manifest, /commandTarget|toolTarget/);
  assert.match(manifest, /SHA-256/);
  assert.match(docs, /v1[^\n]+(?:迁移|migrat)/i);
  assert.doesNotMatch(docs, /its own saved environment variable/);
});

test("OpenCode guide documents cautious update and crash recovery", async () => {
  const docs = await readFile(new URL("../docs/opencode.md", import.meta.url), "utf8");

  const update = markdownSection(docs, "更新与已修改文件");
  const recovery = markdownSection(docs, "崩溃与事务恢复");
  const threatBoundary = markdownSection(docs, "路径安全与威胁边界");

  assert.match(update, /modified owned file|已修改的 owned file/i);
  assert.match(update, /不要(?:直接|盲目)删除/);
  assert.match(update, /来源/);
  assert.match(update, /备份/);
  assert.match(recovery, /\.legacy-code-atlas\.transaction\.json/);
  assert.match(recovery, /journal/i);
  assert.match(recovery, /回滚/);
  assert.match(recovery, /不要手工删除[^。\n]*journal[^。\n]*backup/i);
  assert.doesNotMatch(recovery, /(?:建议|应该|可以|请)[^。\n]*(?:删除|清理)[^。\n]*(?:journal|backup)/i);
  const unsafeRecoveryAdvice = recovery
    .split("\n")
    .filter((line) => /(?:删除|清理).*?(?:journal|backup)|(?:journal|backup).*?(?:删除|清理)/i.test(line))
    .filter((line) => !/(?:不要|不得|禁止|拒绝|恢复逻辑|安装器)/.test(line));
  assert.deepEqual(unsafeRecoveryAdvice, []);
  assert.match(threatBoundary, /reparse/i);
  assert.match(threatBoundary, /同一 Windows (?:用户|账户)/);
  assert.match(threatBoundary, /威胁模型之外/);
});

test("OpenCode guide defines the real Windows release gate", async () => {
  const docs = await readFile(new URL("../docs/opencode.md", import.meta.url), "utf8");
  const releaseGate = markdownSection(docs, "真实 Windows 发布门禁");

  assert.match(releaseGate, /npm run test:installer:windows/);
  assert.match(releaseGate, /50 pass/);
  assert.match(releaseGate, /0 skip/);
  assert.match(releaseGate, /真实 Windows/);
  assert.match(releaseGate, /非 Windows[^\n]+skip/);
  assert.doesNotMatch(releaseGate, /PowerShell 7/);
});

test("documentation states the current analyzer and data-safety limits", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const docs = await readFile(new URL("../docs/opencode.md", import.meta.url), "utf8");
  const combined = `${readme}\n${docs}`;

  const readmeLimits = markdownSection(readme, "当前限制");
  const guideLimits = markdownSection(docs, "当前分析边界");

  assert.match(readme, /\.legacy-code-atlasignore/);
  assert.match(combined, /不运行[^\n]*(?:SQL|procedure)/i);
  assert.match(combined, /敏感/);
  for (const limits of [readmeLimits, guideLimits]) {
    assert.match(limits, /SQL Server[^\n]*(?:procedure|存储过程)[^\n]*(?:CREATE|ALTER)[^\n]*EXEC[^\n]*(?:读|写)/i);
    assert.match(limits, /Struts 2[^\n]*namespace[^\n]*action[^\n]*method[^\n]*result/i);
    assert.match(limits, /Tiles[^\n]*definition[^\n]*template[^\n]*put/i);
    assert.match(limits, /Java[^\n]*(?:局部变量|local variable)/i);
    assert.match(limits, /(?:动态|反射|缺失源码|复核)/i);
    assert.doesNotMatch(
      limits,
      /(?:已完成|已经完成|可用|完整支持|现已支持|当前支持|已经支持)[^。\n]*(?:缓存|cache|增量|incremental)|(?:缓存|cache|增量|incremental)[^。\n]*(?:已完成|已经完成|可用|完整支持|现已支持|当前支持|已经支持)/i,
    );
  }
  assert.doesNotMatch(combined, /--(?:workers|cache|benchmark|incremental)\b/);
  assert.match(readme, /npm run benchmark/);
  assert.match(readme, /至少比 baseline 快 `3\.00x`/);
});
