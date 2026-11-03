import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The installer (PowerShell) and the doctor (Node) are written in different
// languages and cannot import a shared manifest definition at runtime: the
// doctor validates an installed manifest without knowing where the atlas
// repo lives. This test is the single source of truth that pins their
// agreement on the current manifest version, so a change to one side
// without the other fails here instead of silently breaking installs.
test("installer and doctor agree on the current install manifest shape", async () => {
  const [installer, doctor] = await Promise.all([
    readFile(new URL("../install.ps1", import.meta.url), "utf8"),
    readFile(new URL("../src/opencode-doctor.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(installer, /\$OwnerValueV3 = "legacy-code-atlas-install-v3"/);
  assert.match(installer, /owner = \$OwnerValueV3/);
  assert.match(installer, /version = 3/);
  assert.match(installer, /kind = "agent-skill"/);
  assert.match(installer, /\$SkillTarget = Join-Path \$SkillDir "SKILL\.md"/);
  assert.match(installer, /\$SkillDir = Join-Path \$HOME "\.agents\\skills\\atlas"/);
  assert.match(installer, /\$InstallDir = Join-Path \$HOME "\.legacy-code-atlas"/);

  assert.match(doctor, /manifest\.owner !== `legacy-code-atlas-install-v\$\{version\}`/);
  assert.match(doctor, /path\.join\(homeDir, "\.legacy-code-atlas"\)/);
  assert.match(doctor, /path\.join\(homeDir, "\.agents", "skills", "atlas", "SKILL\.md"\)/);
  assert.match(doctor, /manifest\.ownedFiles\.length === 1/);
  assert.match(doctor, /validOwnedFile\(manifest\.ownedFiles\[0\], "agent-skill", skillTarget/);
});
