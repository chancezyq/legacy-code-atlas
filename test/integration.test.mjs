import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

function markdownSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## ${heading}`);
  assert.notEqual(start, -1, `missing Markdown section: ${heading}`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

test("legacy query command templates use the structured query-file protocol", async () => {
  const find = await readFile(new URL("../integrations/opencode/commands/legacy-find.md", import.meta.url), "utf8");
  const table = await readFile(new URL("../integrations/opencode/commands/legacy-table.md", import.meta.url), "utf8");

  for (const [name, content, command] of [
    ["find", find, "trace-feature"],
    ["table", table, "trace-table"],
  ]) {
    assert.equal(content.includes("!`"), false, `${name} must not eagerly execute shell blocks`);
    assert.doesNotMatch(content, /legacy_atlas_/);
    assert.doesNotMatch(content, /\bBun\b/);
    assert.equal(
      [...content.matchAll(/\$ARGUMENTS/g)].length,
      1,
      `${name} must expose its command query exactly once`,
    );
    assert.match(content, /<query>\r?\n\$ARGUMENTS\r?\n<\/query>/);
    assert.match(content, /structured\s+`write`/i);
    assert.match(content, /\.legacy-code-atlas[\\/]query\.txt/);
    assert.match(content, /metadata-only[^\n]+(?:existence|exists)/i);
    assert.match(content, /if[^\n]+index[^\n]+missing[^\n]+`\/atlas`[^\n]+by itself/i);
    assert.match(content, /structured\s+`write`[^\n]+(?:selected|derived)[^\n]+(?:candidate|identifier)/i);
    assert.match(content, /node\s+"?\$HOME\/[.]legacy-code-atlas\/bin\/legacy-code-atlas\.mjs"?/);
    assert.match(content, new RegExp(`${command}[^\\n]+--query-file`));
    assert.match(content, /do not[^\n]*(?:shell|interpolate|insert)[^\n]*(?:question|message|argument)/i);

    const shellBlocks = [...content.matchAll(/```(?:sh|shell|bash)\r?\n([\s\S]*?)```/gi)];
    assert.equal(shellBlocks.length, 2, `${name} must contain fixed preflight and trace shell blocks`);
    for (const shellBlock of shellBlocks) assert.doesNotMatch(shellBlock[1], /\$ARGUMENTS|<\/?query>/i);
    assert.equal(
      shellBlocks[0][1].trim(),
      'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" prepare-query "$PWD"',
      `${name} first shell block must prepare a safe query file`,
    );
    assert.equal(
      shellBlocks[1][1].trim(),
      `node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" ${command} "$PWD" --query-file "$PWD/.legacy-code-atlas/query.txt" --no-match-ok`,
      `${name} shell block must contain only the fixed CLI command`,
    );
  }
});

test("OpenCode trace commands preserve no-match output for bounded fallbacks", async () => {
  const files = [
    "../integrations/opencode/skills/atlas/SKILL.md",
    "../integrations/opencode/AGENTS.fragment.md",
    "../integrations/opencode/commands/legacy-find.md",
    "../integrations/opencode/commands/legacy-table.md",
  ];

  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /--query-file[^\n]+--no-match-ok/);
    assert.match(source, /no-match[^\n]+(?:exit|status)[^\n]+0|exit[^\n]+0[^\n]+no-match/i);
  }
});

test("OpenCode prepares the query file before every structured write", async () => {
  const files = [
    "../integrations/opencode/skills/atlas/SKILL.md",
    "../integrations/opencode/commands/legacy-find.md",
    "../integrations/opencode/commands/legacy-table.md",
  ];
  const prepare = 'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" prepare-query "$PWD"';

  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const prepareIndex = source.indexOf(prepare);
    const writeIndex = source.indexOf("structured `write`", prepareIndex);
    const traceIndex = source.indexOf("--query-file", writeIndex);
    assert.notEqual(prepareIndex, -1, `${file} must run the fixed query-file preflight`);
    assert.notEqual(writeIndex, -1, `${file} must structured-write after preflight`);
    assert.notEqual(traceIndex, -1, `${file} must trace after structured write`);
    assert.ok(prepareIndex < writeIndex && writeIndex < traceIndex, `${file} must prepare -> write -> trace`);
  }
});

test("structured write receives a project-relative path while Shell receives $PWD", async () => {
  const files = [
    "../integrations/opencode/skills/atlas/SKILL.md",
    "../integrations/opencode/AGENTS.fragment.md",
    "../integrations/opencode/commands/legacy-find.md",
    "../integrations/opencode/commands/legacy-table.md",
  ];

  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const writeInstruction = source
      .split(/\r?\n/)
      .find((line) => /structured\s+`write`/i.test(line));

    assert.ok(writeInstruction, `${file} must define a structured write instruction`);
    assert.match(
      writeInstruction,
      /project-relative[^\n]+`\.legacy-code-atlas\/query\.txt`/i,
    );
    assert.doesNotMatch(writeInstruction, /\$PWD/);
    assert.match(source, /never pass[^\n]+literal[^\n]+`\$PWD`[^\n]+`write`/i);
    assert.match(
      source,
      /--query-file\s+"\$PWD\/\.legacy-code-atlas\/query\.txt"/,
    );
  }
});

test("atlas is a no-argument OpenCode Agent Skill", async () => {
  const atlasSkill = await readFile(new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url), "utf8");
  const frontmatter = atlasSkill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");
  assert.match(frontmatter[1], /^name:\s*atlas\s*$/m);
  assert.match(frontmatter[1], /^description:\s*\S.+$/m);
  assert.equal(atlasSkill.includes("$ARGUMENTS"), false);
  assert.equal(atlasSkill.includes("!`"), false);
  assert.doesNotMatch(atlasSkill, /legacy_atlas_/);
  assert.match(atlasSkill, /only when the user invokes `\/atlas` with no arguments/i);
  assert.match(atlasSkill, /node\s+"?\$HOME\/[.]legacy-code-atlas\/bin\/legacy-code-atlas\.mjs"?\s+doctor\s+"?\$PWD"?/i);
  assert.match(atlasSkill, /node\s+"?\$HOME\/[.]legacy-code-atlas\/bin\/legacy-code-atlas\.mjs"?\s+analyze\s+"?\$PWD"?\s+--main-thread/i);
  assert.match(atlasSkill, /main thread[^\n]+(?:worker_threads|worker threads)/i);
  assert.match(atlasSkill, /node\s+"?\$HOME\/[.]legacy-code-atlas\/bin\/legacy-code-atlas\.mjs"?\s+overview\s+"?\$PWD"?/i);
  assert.match(atlasSkill, /next ordinary message/i);
  assert.match(atlasSkill, /do not append[^\n]+`\/atlas`/i);
});

test("atlas gates analysis on a separate successful doctor Shell call", async () => {
  const atlasSkill = await readFile(new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url), "utf8");
  const shellBlocks = [...atlasSkill.matchAll(/```(?:sh|shell|bash)\r?\n([\s\S]*?)```/gi)];
  const doctor = 'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" doctor "$PWD"';
  const analyze = 'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" analyze "$PWD" --main-thread';
  const doctorBlock = shellBlocks.find((match) => match[1].trim() === doctor);
  const analyzeBlock = shellBlocks.find((match) => match[1].trim() === analyze);

  assert.ok(doctorBlock, "doctor must be one fixed Shell call");
  assert.ok(analyzeBlock, "analyze must be one fixed Shell call");
  assert.ok(doctorBlock.index < analyzeBlock.index, "doctor must precede analyze");
  const gate = atlasSkill.slice(doctorBlock.index, analyzeBlock.index + analyzeBlock[0].length);
  assert.match(gate, /if and only if[^\n]+doctor[^\n]+(?:exit|status)[^\n]+0[^\n]+analyze/i);
  assert.match(gate, /(?:read-only|does not (?:modify|delete|move))[^\n]+(?:OpenCode|tool|config)/i);
});

test("atlas gates overview on a separate successful analyze Shell call", async () => {
  const atlasSkill = await readFile(new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url), "utf8");
  const shellBlocks = [...atlasSkill.matchAll(/```(?:sh|shell|bash)\r?\n([\s\S]*?)```/gi)];
  const analyze = 'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" analyze "$PWD" --main-thread';
  const overview = 'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" overview "$PWD"';
  const analyzeBlock = shellBlocks.find((match) => match[1].trim() === analyze);
  const overviewBlock = shellBlocks.find((match) => match[1].trim() === overview);

  assert.ok(analyzeBlock, "analyze must be one fixed Shell call");
  assert.ok(overviewBlock, "overview must be a separate fixed Shell call");
  assert.ok(analyzeBlock.index < overviewBlock.index, "overview must follow analyze");
  const gate = atlasSkill.slice(analyzeBlock.index, overviewBlock.index + overviewBlock[0].length);
  assert.match(gate, /if and only if[^\n]+(?:analyze|call)[^\n]+(?:exit|status)[^\n]+0[^\n]+(?:second|separate)[^\n]+(?:call|overview)/i);
  assert.match(atlasSkill, /if (?:either|any)[^\n]+fails?[^\n]+stop[^\n]+report[^\n]+(?:do not|never)[^\n]+(?:claim|report)[^\n]+(?:refreshed|success)/i);
});

test("atlas metadata covers post-index questions across turns", async () => {
  const atlasSkill = await readFile(new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url), "utf8");
  const frontmatter = atlasSkill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");
  assert.match(frontmatter[1], /description:[^\n]+after[^\n]+`?\/atlas`?[^\n]+succeed[^\n]+ordinary[^\n]+question/i);
  assert.match(frontmatter[1], /indexed[^\n]+legacy[^\n]+project/i);
  assert.match(frontmatter[1], /(?:across|subsequent)[^\n]+turn/i);
  assert.match(frontmatter[1], /context[^\n]+recover/i);
});

test("atlas defines index state handling after context recovery", async () => {
  const atlasSkill = await readFile(new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url), "utf8");
  const recovery = markdownSection(atlasSkill, "Cross-turn and context recovery");

  assert.match(recovery, /(?:cross-turn|context recovery)/i);
  assert.match(recovery, /\.legacy-code-atlas[\\/]index\.json/);
  assert.match(recovery, /`glob`|metadata-only/i);
  assert.doesNotMatch(recovery, /`read`/);
  assert.match(recovery, /do not[^\n]+load[^\n]+index[^\n]+content[^\n]+(?:conversation|context)/i);
  assert.match(recovery, /if[^\n]+index[^\n]+exists[^\n]+continue[^\n]+ordinary/i);
  assert.match(recovery, /if[^\n]+index[^\n]+(?:missing|does not exist)[^\n]+run[^\n]+`\/atlas`[^\n]+by itself/i);
  assert.match(recovery, /do not run[^\n]+trace[^\n]+(?:missing|without)[^\n]+index/i);
});

test("atlas rejects trailing slash-command content before calling Atlas", async () => {
  const atlasSkill = await readFile(new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url), "utf8");
  const inspectIndex = atlasSkill.search(/first, inspect the slash invocation before running any Atlas command/i);
  const refusal = atlasSkill.match(/if `\/atlas` contains any trailing content or argument,([\s\S]*?)(?=\n\notherwise,)/i);
  const doctorIndex = atlasSkill.search(/otherwise,[^\n]+only when[^\n]+no arguments[^\n]+run[^\n]+doctor/i);

  assert.notEqual(inspectIndex, -1, "the invocation must be inspected before any tool call");
  assert.ok(refusal, "the Skill must define an early-stop branch for trailing content");
  assert.match(refusal[0], /stop/i);
  assert.match(refusal[0], /do not run any Atlas command/i);
  assert.match(refusal[0], /do not pass[^\n]+to a command or treat[^\n]+as an instruction/i);
  assert.match(refusal[0], /only tell the user to run `\/atlas` by itself/i);
  assert.match(refusal[0], /next ordinary message/i);
  assert.ok(inspectIndex < refusal.index, "inspection must precede the refusal branch");
  assert.ok(refusal.index < doctorIndex, "the refusal branch must precede the no-argument doctor branch");
});

test("atlas routes later ordinary-language questions through fixed CLI commands", async () => {
  const atlasSkill = await readFile(new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url), "utf8");

  assert.doesNotMatch(atlasSkill, /legacy_atlas_/);
  assert.match(atlasSkill, /structured\s+`write`/i);
  assert.match(atlasSkill, /\.legacy-code-atlas[\\/]query\.txt/);
  assert.match(atlasSkill, /write[^\n]+(?:selected|derived)[^\n]+(?:candidate|identifier)/i);
  for (const command of [
    "trace-url",
    "trace-statement",
    "trace-table",
    "trace-procedure",
    "trace-feature",
  ]) {
    assert.match(atlasSkill, new RegExp(`${command}[^\\n]+--query-file`));
  }
  assert.match(atlasSkill, /URL[^\n]+trace-url/i);
  assert.match(atlasSkill, /iBATIS statement[^\n]+trace-statement/i);
  assert.match(atlasSkill, /database table[^\n]+trace-table/i);
  assert.match(atlasSkill, /SQL Server procedure[^\n]+trace-procedure/i);
  assert.match(atlasSkill, /feature[^\n]+trace-feature/i);
});

test("OpenCode guidance derives bounded source-language candidates for natural questions", async () => {
  const files = [
    "../integrations/opencode/skills/atlas/SKILL.md",
    "../integrations/opencode/AGENTS.fragment.md",
    "../integrations/opencode/commands/legacy-find.md",
  ];

  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /(?:concise|short)[^\n]+source-language[^\n]+(?:candidate|term)/i);
    assert.match(source, /translate[^\n]+(?:question|business terms?)[^\n]+source[^\n]+language/i);
    assert.match(source, /(?:at most|maximum of)[^\n]+two[^\n]+alternative[^\n]+candidate/i);
    assert.match(source, /structured\s+`write`[^\n]+(?:candidate|term)/i);
    assert.doesNotMatch(source, /write[^\n]+complete[^\n]+question[^\n]+exactly as received/i);
  }

  const skill = await readFile(new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /explicit[^\n]+(?:URL|statement)[^\n]+(?:preserve|exact)/i);
  assert.match(skill, /订单审核功能在哪里？[^\n]+OrderAudit/i);
  assert.match(skill, /report[^\n]+candidate/i);
  assert.match(skill, /only[^\n]+natural-language[^\n]+alternative[^\n]+candidate/i);
  assert.match(skill, /(?:do not|never)[^\n]+(?:alter|translate|replace)[^\n]+explicit[^\n]+identifier/i);
});

test("table command preserves explicit identifiers while translating natural descriptions", async () => {
  const table = await readFile(new URL("../integrations/opencode/commands/legacy-table.md", import.meta.url), "utf8");

  assert.match(table, /explicit[^\n]+table[^\n]+(?:preserve|exact)/i);
  assert.match(table, /natural-language[^\n]+translate[^\n]+source[^\n]+language/i);
  assert.match(table, /structured\s+`write`[^\n]+(?:candidate|identifier)/i);
  assert.match(table, /(?:at most|maximum of)[^\n]+two[^\n]+alternative[^\n]+candidate/i);
  assert.match(table, /only[^\n]+natural-language[^\n]+alternative[^\n]+candidate/i);
  assert.match(table, /(?:do not|never)[^\n]+(?:alter|translate|replace)[^\n]+explicit[^\n]+identifier/i);
  assert.doesNotMatch(table, /write[^\n]+complete[^\n]+(?:text|content)[^\n]+exactly as received/i);
});

test("README compatibility requirements name every host capability used by the Skill", async () => {
  const readmes = await Promise.all([
    "../README.md",
    "../README_EN.md",
  ].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

  for (const readme of readmes) {
    assert.match(readme, /structured\s+`write`/i);
    assert.match(readme, /metadata-only[^\n]+(?:existence|存在)/i);
  }
});

test("OpenCode guidance defines Shell semantics and large-scan timeout requirements", async () => {
  const skill = await readFile(
    new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url),
    "utf8",
  );
  const documents = await Promise.all([
    "../README.md",
    "../README_EN.md",
    "../docs/opencode.md",
    "../docs/opencode-en.md",
  ].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

  for (const source of [skill, ...documents]) {
    assert.match(source, /(?:PowerShell|POSIX)[^\n]+(?:Git Bash|POSIX)[^\n]+\$HOME[^\n]+\$PWD/i);
    assert.match(source, /cmd\.exe[^\n]+(?:unsupported|不支持)/i);
    assert.match(source, /(?:maximum|max(?:imum)?|最长)[^\n]+(?:supported|支持)[^\n]+timeout|timeout[^\n]+(?:maximum|max(?:imum)?|最长)[^\n]+(?:supported|支持)/i);
    assert.match(source, /background[^\n]+(?:wait|等待)/i);
    assert.match(source, /(?:short|短)[^\n]+(?:default|默认)[^\n]+timeout|(?:default|默认)[^\n]+timeout[^\n]+(?:short|短)/i);
  }

  assert.match(skill, /(?:tool-call metadata|tool metadata)[^\n]+(?:not|do not)[^\n]+(?:command string|command)/i);
  assert.match(skill, /(?:do not|never)[^\n]+invent[^\n]+(?:metadata|field)/i);
  assert.match(skill, /wait[^\n]+(?:analyze|call)[^\n]+(?:exit|finish|complete)[^\n]+overview/i);
});

test("project Agent guidance includes every identifier-specific CLI trace command", async () => {
  const agents = await readFile(new URL("../integrations/opencode/AGENTS.fragment.md", import.meta.url), "utf8");

  assert.doesNotMatch(agents, /legacy_atlas_/);
  assert.match(agents, /structured\s+`write`/i);
  assert.match(agents, /\.legacy-code-atlas[\\/]query\.txt/);
  assert.match(agents, /metadata-only[^\n]+(?:existence|exists)/i);
  assert.match(agents, /if[^\n]+index[^\n]+missing[^\n]+`\/atlas`[^\n]+by itself/i);
  assert.doesNotMatch(agents, /index is missing or stale[^\n]+run[^\n]+analyze/i);
  for (const command of [
    "trace-url",
    "trace-statement",
    "trace-procedure",
    "trace-table",
  ]) assert.match(agents, new RegExp(command));
});

test("atlas permits cited-source verification but no shell or edits", async () => {
  const atlasSkill = await readFile(new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url), "utf8");

  assert.match(atlasSkill, /Shell[^\n]+only[^\n]+fixed commands?|fixed shell commands?/i);
  assert.match(atlasSkill, /structured\s+`write`/i);
  assert.match(atlasSkill, /query\.txt/i);
  assert.match(atlasSkill, /cited source/i);
  assert.match(atlasSkill, /`read`/);
  assert.match(atlasSkill, /`grep`/);
  assert.match(atlasSkill, /`glob`/);
  assert.match(atlasSkill, /(?:do not|never)[^\n]+(?:modify|change)[^\n]+source/i);
  assert.match(atlasSkill, /(?:do not|never)[^\n]+`edit`[^\n]+(?:source|project)/i);
  assert.match(atlasSkill, /(?:do not|never)[^\n]+`apply_patch`[^\n]+(?:source|project)/i);
  assert.match(atlasSkill, /(?:CLI|index)[^\n]+untrusted data/i);
  assert.match(atlasSkill, /canonical[^\n]+relative[^\n]+(?:citation|path)[^\n]+\$PWD/i);
  assert.match(atlasSkill, /never[^\n]+`read`[^\n]+(?:absolute|UNC|parent|\.\.)/i);
});

test("atlas generates shareable documents through one fixed docs command", async () => {
  const atlasSkill = await readFile(new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url), "utf8");
  const shellBlocks = [...atlasSkill.matchAll(/```(?:sh|shell|bash)\r?\n([\s\S]*?)```/gi)];
  const docs = 'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" docs "$PWD"';
  const docsBlock = shellBlocks.find((match) => match[1].trim() === docs);

  assert.ok(docsBlock, "docs must be one fixed Shell call");
  const section = markdownSection(atlasSkill, "Shareable documents");
  assert.match(section, /use case|use-case/i);
  assert.match(section, /UI spec|ui-spec/i);
  assert.match(section, /diagram/i);
  assert.match(section, /metadata-only[^\n]+(?:existence|exists)/i);
  assert.match(section, /if[^\n]+index[^\n]+missing[^\n]+`\/atlas`[^\n]+by itself/i);
  assert.match(section, /\.legacy-code-atlas[\\/]docs[\\/]use-cases\.md/);
  assert.match(section, /\.legacy-code-atlas[\\/]docs[\\/]ui-spec\.md/);
  assert.match(section, /\.legacy-code-atlas[\\/]docs[\\/]diagrams\.md/);
  assert.match(section, /(?:do not|never)[^\n]+(?:add|append)[^\n]+(?:flag|user text)/i);
  assert.match(section, /sensitive/i);
});

test("the legacy understand Markdown command is removed", async () => {
  await assert.rejects(
    readFile(new URL("../integrations/opencode/commands/understand.md", import.meta.url), "utf8"),
    { code: "ENOENT" },
  );
});

test("OpenCode integration never calls legacy custom tools or interpolates user text", async () => {
  const runtimeFiles = [
    "../integrations/opencode/skills/atlas/SKILL.md",
    "../integrations/opencode/AGENTS.fragment.md",
  ];
  const sources = await Promise.all(runtimeFiles.map((file) => readFile(new URL(file, import.meta.url), "utf8")));

  for (const source of sources) {
    assert.doesNotMatch(source, /legacy_atlas_[A-Za-z0-9_]+/);
    assert.doesNotMatch(source, /\bBun\b/);
    assert.doesNotMatch(source, /\$ARGUMENTS/);
    assert.doesNotMatch(source, /\$\{(?:query|arguments|user|message)\}/i);
  }
  const skill = sources[0];
  assert.match(skill, /never[^\n]*(?:interpolate|insert|embed)[^\n]*(?:user|question|message)[^\n]*(?:shell|command)/i);
  assert.match(skill, /only fixed[^\n]+commands?/i);
});

test("OpenCode integration ships no TypeScript custom tool", async () => {
  await assert.rejects(
    access(new URL("../integrations/opencode/tools/legacy_atlas.ts", import.meta.url)),
    (error) => error?.code === "ENOENT",
  );
});

test("user documentation shows only standalone atlas invocations", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const docs = await readFile(new URL("../docs/opencode.md", import.meta.url), "utf8");

  for (const [name, content] of [["README", readme], ["OpenCode guide", docs]]) {
    const invocationLines = content.match(/^.*\/atlas.*$/gm) ?? [];
    const codeExamples = invocationLines
      .map((line) => line.trim())
      .filter((line) => !line.includes("`") && !line.startsWith("#"));

    assert.ok(codeExamples.length > 0, `${name} must show the slash invocation`);
    assert.deepEqual(
      [...new Set(codeExamples)],
      ["/atlas"],
      `${name} must never append a query to /atlasSkill`,
    );
    assert.doesNotMatch(content, /\/atlas[ \t]+(?=[^`\r\n])/);
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
  assert.match(readme, /%USERPROFILE%\\\.agents\\skills\\atlas\\SKILL\.md/);
  assert.match(readme, /OPENCODE_CONFIG_DIR/);
  assert.match(readme, /configDir/);
  assert.match(readme, /(?:不会|不再)[^\n]*(?:创建|安装|写入)[^\n]*legacy_atlas\.ts/i);
  assert.match(readme, /不联网/);
  assert.doesNotMatch(readme, /\$env:LEGACY_CODE_ATLAS_CLI|Copy-Item|npm link/);
});

test("user documentation describes the true Skill-only runtime and one-time legacy-tool retirement", async () => {
  const documents = await Promise.all([
    "../README.md",
    "../README_EN.md",
    "../docs/opencode.md",
    "../docs/opencode-en.md",
  ].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

  for (const document of documents) {
    assert.match(document, /Skill-only/i);
    assert.match(document, /\.legacy-code-atlas[\\/]query\.txt/);
    assert.match(document, /--query-file/);
    assert.match(document, /legacy_atlas\.ts/);
    assert.match(document, /(?:retir|remove|移除|退役)/i);
    assert.match(document, /(?:will not|does not|不会|不再)[^\n]*(?:create|install|write|创建|安装|写入)[^\n]*legacy_atlas\.ts/i);
    assert.doesNotMatch(document, /(?:tombstone|占位)/i);
    assert.doesNotMatch(document, /export \{\};/);
    assert.match(document, /Bun is not defined/);
    assert.match(document, /configDir/);
    assert.match(document, /Get-FileHash/);
    assert.match(document, /Select-String/);
    assert.match(document, /worker failed/);
    assert.match(document, /\/home\/\*/);
    assert.match(document, /C:\\\\company\\\\app/);
    assert.match(document, /(?:完全退出|fully exit)[^\n]*OpenCode/i);
    assert.match(document, /(?:custom-tool|custom tool)[^\n]+(?:loader|加载器)/i);
    assert.doesNotMatch(document, /query\.txt[^\n]+(?:user questions|用户问题)/i);
  }

  for (const guide of documents.slice(2)) {
    assert.match(guide, /70 pass/);
    assert.match(guide, /0 skip/);
    assert.match(guide, /(?:不代表|does not claim|not evidence)/i);
  }
});

test("compatibility design does not treat Understand-Anything as proof of Atlas host support", async () => {
  const design = await readFile(
    new URL("../docs/plans/2026-07-21-opencode-skill-compatibility-design.md", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(design, /already proven by Understand-Anything/i);
  assert.match(design, /Understand-Anything[^\n]+(?:similar|partial)[^\n]+(?:not|cannot)[^\n]+(?:proof|validation)/i);
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

test("OpenCode recovery documentation uses one-file manifest v3 ownership", async () => {
  const docs = await readFile(new URL("../docs/opencode.md", import.meta.url), "utf8");
  const manifest = markdownSection(docs, "manifest v3");

  assert.match(docs, /OpenCode 1\.14\.49/);
  assert.match(manifest, /ConvertFrom-Json/);
  assert.match(manifest, /legacy-code-atlas-install-v3/);
  assert.match(manifest, /owner/);
  assert.match(manifest, /version/);
  assert.match(manifest, /ownedFiles/);
  assert.match(manifest, /kind/);
  assert.match(manifest, /path/);
  assert.match(manifest, /sha256/);
  assert.match(manifest, /agent-skill/);
  assert.doesNotMatch(manifest, /opencode-tool/);
  assert.match(manifest, /Test-Path -LiteralPath \(Join-Path \$HOME "\.legacy-code-atlas\\bin\\legacy-code-atlas\.mjs"\)/);
  assert.doesNotMatch(manifest, /commandTarget|toolTarget/);
  assert.match(manifest, /SHA-256/);
  assert.match(docs, /v1\/v2[^\n]+(?:迁移|migrat|移除|退役)/i);
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
  assert.match(releaseGate, /70 pass/);
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
