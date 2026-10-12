// Runs test/suite in a real VS Code with only this extension loaded.
// Uses the locally installed VS Code when available (no download), with its own
// throwaway profile so it doesn't touch your settings or other extensions.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const root = path.resolve(__dirname, "..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "live-md-test-"));
  const workspace = path.join(tmp, "vault");
  fs.cpSync(path.join(__dirname, "fixtures"), workspace, { recursive: true });
  // A Windows-style (CRLF) note to check line-ending handling.
  fs.writeFileSync(path.join(workspace, "crlf.md"), "# CRLF note\r\n\r\nfirst line\r\nsecond line\r\n");

  const installed = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe");
  try {
    await runTests({
      vscodeExecutablePath: fs.existsSync(installed) ? installed : undefined,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite", "index.js"),
      launchArgs: [
        workspace,
        "--user-data-dir", path.join(tmp, "user-data"),
        "--extensions-dir", path.join(tmp, "extensions"),
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
      ],
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
