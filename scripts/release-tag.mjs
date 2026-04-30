import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const packageJsonPath = path.join(repoRoot, "package.json");
const tauriConfigPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(repoRoot, "src-tauri", "Cargo.toml");

const args = process.argv.slice(2);
const nextVersion = args[0];
const isDryRun = args.includes("--dry-run");

if (!nextVersion) {
  fail("Missing version. Usage: pnpm release 0.1.1 [--dry-run]");
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  fail(`Invalid version: ${nextVersion}. Use semver without leading v, e.g. 0.1.1`);
}

if (isDryRun) {
  console.log(`Dry run: would prepare release v${nextVersion}.`);
} else {
  ensureCleanWorkingTree();
  ensureTagDoesNotExist(`v${nextVersion}`);
}

const tagName = `v${nextVersion}`;

if (isDryRun) {
  ensureDryRunTagState(tagName);
}


const originalPackageJsonText = readFileSync(packageJsonPath, "utf8");
const originalTauriConfigText = readFileSync(tauriConfigPath, "utf8");
const originalCargoToml = readFileSync(cargoTomlPath, "utf8");

const packageJson = JSON.parse(originalPackageJsonText);
const tauriConfig = JSON.parse(originalTauriConfigText);
const cargoToml = originalCargoToml;

const currentVersions = [
  packageJson.version,
  tauriConfig.version,
  readCargoVersion(cargoToml),
];

if (new Set(currentVersions).size !== 1) {
  fail(
    `Version mismatch detected: package.json=${currentVersions[0]}, tauri.conf.json=${currentVersions[1]}, Cargo.toml=${currentVersions[2]}`,
  );
}

if (currentVersions[0] === nextVersion) {
  fail(`Version is already ${nextVersion}`);
}

packageJson.version = nextVersion;
tauriConfig.version = nextVersion;
const updatedCargoToml = cargoToml.replace(
  /^version\s*=\s*"[^"]+"/m,
  `version = "${nextVersion}"`,
);

const nextPackageJsonText = `${JSON.stringify(packageJson, null, 2)}\n`;
const nextTauriConfigText = `${JSON.stringify(tauriConfig, null, 2)}\n`;

if (isDryRun) {
  console.log(`Would update package.json: ${currentVersions[0]} -> ${nextVersion}`);
  console.log(`Would update src-tauri/tauri.conf.json: ${currentVersions[1]} -> ${nextVersion}`);
  console.log(`Would update src-tauri/Cargo.toml: ${currentVersions[2]} -> ${nextVersion}`);
  console.log(`Would create commit: chore: release v${nextVersion}`);
  console.log(`Would create tag: ${tagName}`);
  process.exit(0);
}

writeFileSync(packageJsonPath, nextPackageJsonText);
writeFileSync(tauriConfigPath, nextTauriConfigText);
writeFileSync(cargoTomlPath, updatedCargoToml);

verifyWrittenVersion(packageJsonPath, nextVersion, "package.json");
verifyWrittenVersion(tauriConfigPath, nextVersion, "src-tauri/tauri.conf.json");
verifyCargoVersion(cargoTomlPath, nextVersion);

runGit(["add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"]);
runGit(["commit", "-m", `chore: release v${nextVersion}`]);
runGit(["tag", "-a", `v${nextVersion}`, "-m", `Release v${nextVersion}`]);

console.log(`Created release commit and tag v${nextVersion}.`);
console.log("Next step: git push origin HEAD --follow-tags");
console.log("Tip: use pnpm release <version> --dry-run to preview without changes.");

function ensureCleanWorkingTree() {
  const output = runGit(["status", "--porcelain"], { capture: true }).trim();
  if (output) {
    fail("Git working tree is not clean. Commit or stash your changes before releasing.");
  }
}

function ensureTagDoesNotExist(tagName) {
  const output = runGit(["tag", "--list", tagName], { capture: true }).trim();
  if (output) {
    fail(`Tag ${tagName} already exists.`);
  }
}

function ensureDryRunTagState(tagName) {
  const output = runGit(["tag", "--list", tagName], { capture: true }).trim();
  if (output) {
    fail(`Dry run failed: tag ${tagName} already exists.`);
  }
}

function readCargoVersion(content) {
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    fail("Could not find version in src-tauri/Cargo.toml");
  }
  return match[1];
}

function verifyWrittenVersion(filePath, expectedVersion, label) {
  const file = JSON.parse(readFileSync(filePath, "utf8"));
  if (file.version !== expectedVersion) {
    fail(`Failed to update ${label} to ${expectedVersion}`);
  }
}

function verifyCargoVersion(filePath, expectedVersion) {
  const version = readCargoVersion(readFileSync(filePath, "utf8"));
  if (version !== expectedVersion) {
    fail(`Failed to update src-tauri/Cargo.toml to ${expectedVersion}`);
  }
}

function runGit(args, options = {}) {
  const result = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return result ?? "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
