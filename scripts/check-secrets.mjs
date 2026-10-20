// Scans every file that is tracked or would be committed (respecting .gitignore) for secrets,
// personal data and private Perusall analysis artefacts. Exit code 1 on any finding.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const SELF = "scripts/check-secrets.mjs";
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && f !== SELF);

const RULES = [
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Password assignment", /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*["'][^"'\s]{6,}["']/i],
  ["Cookie header", /^\s*(cookie|set-cookie)\s*:/im],
  ["Perusall session/view identifier", /\b(documentViewId|pageViewId|chapterViewId)=(?!<)[A-Za-z0-9]{8,}/],
  ["Perusall API host (keep reverse-engineered API details out of the repo)", /backend-production\.perusall\.com/],
  ["Private analysis artefact", /perusall-analysis-profile|X[1-4]-[a-z-]+-capture\.json|session-bundle-\d+\.json/],
  ["Email address", /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org)\b|users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ["Concrete Perusall course/document URL", /perusall\.com\/courses\/(?!:|<|\*)[A-Za-z0-9_-]+/],
];

const findings = [];
for (const file of files) {
  let size;
  try { size = statSync(file).size; } catch { continue; }
  if (size > 5_000_000) continue;
  const buf = readFileSync(file);
  if (buf.includes(0)) continue; // binary
  const text = buf.toString("utf8");
  for (const [name, re] of RULES) {
    // .gitignore lists private artefacts precisely so they are never committed.
    if (file === ".gitignore" && name === "Private analysis artefact") continue;
    const m = re.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split("\n").length;
      findings.push(`${file}:${line}  ${name}`);
    }
  }
}

// --history: also scan every line ever added in any commit (deleting a secret later does not
// remove it from Git history).
if (process.argv.includes("--history")) {
  let log;
  try {
    log = execFileSync("git", ["log", "--all", "-p", "--no-color", "--format=commit %H", "--", ".", `:(exclude)${SELF}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch {
    log = ""; // no commits yet
  }
  let commit = "", file = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("commit ")) { commit = line.slice(7, 14); continue; }
    if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const [name, re] of RULES) {
      if (file === ".gitignore" && name === "Private analysis artefact") continue;
      if (re.test(line.slice(1))) findings.push(`history ${commit} ${file}  ${name}`);
    }
  }
}

if (findings.length) {
  console.error("Sensitive-data check FAILED:\n - " + findings.join("\n - "));
  process.exit(1);
}
console.warn(`Sensitive-data check OK (${files.length} files scanned${process.argv.includes("--history") ? " + full Git history" : ""})`);
