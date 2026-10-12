// Integration tests, run inside VS Code by test/runTests.js.
const assert = require("assert");
const fs = require("fs");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let provider;
const folder = () => vscode.workspace.workspaceFolders[0].uri;
const fileUri = (name) => vscode.Uri.joinPath(folder(), name);

async function openSession(name) {
  const uri = fileUri(name);
  await vscode.commands.executeCommand("vscode.open", uri);
  const session = await waitFor(`a Live Markdown editor for ${name}`, () => provider.sessionFor(uri));
  await waitFor("the webview to start", () => session.ready.then(() => true));
  return session;
}

test(".md files open in Live Markdown by default and the webview renders", async () => {
  const session = await openSession("sample.md");
  const snap = await waitFor("rendered callouts", async () => {
    const s = await session.query();
    return s.counts.callouts > 0 ? s : null;
  });
  assert.strictEqual(snap.livePreview, true);
  assert.strictEqual(snap.counts.inlineTitle, 1, "inline title");
  assert.strictEqual(snap.counts.properties, 1, "frontmatter renders as Properties");
  assert.ok(snap.counts.headings >= 3, `headings: ${snap.counts.headings}`);
  assert.ok(snap.counts.checkboxes >= 2, `checkboxes: ${snap.counts.checkboxes}`);
  assert.ok(snap.counts.internalLinks >= 3, `internal links: ${snap.counts.internalLinks}`);
  assert.ok(snap.counts.tags >= 1, `tags: ${snap.counts.tags}`);
  assert.strictEqual(snap.text, session.document.getText().replace(/\r\n/g, "\n"));
});

test("typing in the webview edits the VS Code document", async () => {
  const session = await openSession("sample.md");
  const before = session.document.getText();
  const at = before.indexOf("# Heading one") + 2;
  session.post({ type: "testType", at, text: "Big " });
  await waitFor("document edit", () => session.document.getText().includes("# Big Heading one"));
  await session.flushed();
  assert.ok(session.document.isDirty, "document is dirty after typing");
  const snap = await session.query();
  assert.strictEqual(snap.text, session.document.getText());
});

test("changes made outside the webview show up in it", async () => {
  const session = await openSession("sample.md");
  const edit = new vscode.WorkspaceEdit();
  edit.insert(session.document.uri, new vscode.Position(session.document.lineCount - 1, 0), "Added from outside\n");
  assert.ok(await vscode.workspace.applyEdit(edit));
  await waitFor("webview to receive the external edit", async () => (await session.query()).text.includes("Added from outside"));
  const snap = await session.query();
  assert.strictEqual(snap.text, session.document.getText());
});

test("CRLF files keep their line endings and stay in sync", async () => {
  const session = await openSession("crlf.md");
  assert.strictEqual(session.document.eol, vscode.EndOfLine.CRLF);
  const text = (await session.query()).text;
  const at = text.indexOf("second line");
  session.post({ type: "testType", at, text: "inserted\nline, " });
  await waitFor("CRLF edit", () => session.document.getText().includes("inserted\r\nline, second line"));
  await session.flushed();
  await sleep(300);
  const snap = await session.query();
  assert.strictEqual(snap.text, session.document.getText().replace(/\r\n/g, "\n"));
  assert.ok(!/[^\r]\n/.test(session.document.getText()), "no bare LF in a CRLF document");
  await session.document.save();
  assert.ok(fs.readFileSync(session.document.uri.fsPath, "utf8").includes("inserted\r\nline, second line"));
});

test("source mode toggle command switches the rendering", async () => {
  const session = await openSession("sample.md");
  await vscode.commands.executeCommand("liveMarkdown.toggleSourceMode");
  await waitFor("source mode", async () => (await session.query()).livePreview === false);
  await vscode.commands.executeCommand("liveMarkdown.toggleSourceMode");
  await waitFor("live preview", async () => (await session.query()).livePreview === true);
});

test("following [[links]] opens existing notes and creates missing ones", async () => {
  const session = await openSession("sample.md");
  await session["onMessage"]({ type: "openWikiLink", target: "Other Note", newTab: false });
  await waitFor("Other Note to open", () => provider.sessionFor(fileUri("Other Note.md")));
  await session["onMessage"]({ type: "openWikiLink", target: "Brand New Note", newTab: false });
  await waitFor("Brand New Note to be created", () => fs.existsSync(fileUri("Brand New Note.md").fsPath));
  await waitFor("Brand New Note to open", () => provider.sessionFor(fileUri("Brand New Note.md")));
});

test("embeds and images resolve against the workspace", async () => {
  const session = await openSession("sample.md");
  const note = await provider.sessionFor(fileUri("sample.md"))["notes"].resolveEmbed("Other Note#Section", session.document.uri, session.panel.webview);
  assert.strictEqual(note.kind, "note");
  assert.ok(note.markdown.includes("## Section"));
  const image = await session["notes"].resolveEmbed("diagram.svg", session.document.uri, session.panel.webview);
  assert.strictEqual(image.kind, "image");
  assert.ok(image.uri.includes("diagram.svg"));
  const missing = await session["notes"].resolveEmbed("nope.png", session.document.uri, session.panel.webview);
  assert.strictEqual(missing.kind, "missing");
});

test("foldable callouts start folded and the chevron toggles them without editing the file", async () => {
  const session = await openSession("sample.md");
  session.post({ type: "testScrollTo", text: "[!faq]-" });
  let snap = await waitFor("a folded callout", async () => {
    const s = await session.query();
    return s.counts.calloutFolds === 2 && s.counts.collapsedCallouts === 1 ? s : null;
  });
  assert.ok(!snap.renderedText.includes("Hidden answer"), "the folded body is hidden");
  const before = session.document.getText();
  session.post({ type: "testClick", selector: ".lm-callout-fold.is-collapsed" });
  snap = await waitFor("the callout to expand", async () => {
    const s = await session.query();
    return s.counts.collapsedCallouts === 0 && s.renderedText.includes("Hidden answer") ? s : null;
  });
  session.post({ type: "testClick", selector: ".lm-callout-fold", index: 1 });
  await waitFor("the open callout to fold", async () => (await session.query()).counts.collapsedCallouts === 1);
  assert.strictEqual(session.document.getText(), before, "folding doesn't change the file");
});

test("table cells are edited in place, and Tab past the last cell adds a row", async () => {
  const session = await openSession("sample.md");
  session.post({ type: "testScrollTo", text: "| Feature" });
  await waitFor("a rendered table", async () => (await session.query()).counts.tables === 1);

  session.post({ type: "testClick", selector: ".lm-table td", index: 1 }); // "done"
  await waitFor("a cell editor", async () => (await session.query()).counts.activeCells === 1);
  session.post({ type: "testKey", key: "End" });
  session.post({ type: "testType", text: "!" });
  await waitFor("the cell edit in the document", () => session.document.getText().includes("| Tables | done! |"));

  session.post({ type: "testClick", selector: ".lm-table td", index: 5 }); // the last cell
  await waitFor("the last cell's editor", async () => (await session.query()).counts.activeCells === 1);
  session.post({ type: "testKey", key: "Tab" });
  await waitFor("a new row", () => session.document.getText().includes("| Math | $x^2$ | [[Other Note]] |\n|  |  |  |"));
  session.post({ type: "testType", text: "Added" });
  await waitFor("typing in the new row", () => session.document.getText().includes("| Added |  |  |"));
  await session.flushed();
  const snap = await session.query();
  assert.strictEqual(snap.text, session.document.getText().replace(/\r\n/g, "\n"));
  assert.strictEqual(snap.counts.tables, 1, "the table stays rendered while editing");
  assert.strictEqual(snap.counts.activeCells, 1, "still editing the new cell");
});

test("the heading colour settings reach the editor", async () => {
  const session = await openSession("sample.md");
  const config = vscode.workspace.getConfiguration("liveMarkdown");
  await config.update("headingColor", "#e0af68", vscode.ConfigurationTarget.Global);
  try {
    await waitFor("the heading colour", async () => (await session.query()).headingColor.trim() === "#e0af68");
  } finally {
    await config.update("headingColor", undefined, vscode.ConfigurationTarget.Global);
  }
  await waitFor("the default heading colour", async () => (await session.query()).headingColor.trim() === "");
});

test("Open as Plain Text reopens the file in the normal text editor", async () => {
  await openSession("sample.md");
  await vscode.commands.executeCommand("liveMarkdown.openSource");
  await waitFor("text editor", () => vscode.window.activeTextEditor?.document.uri.path.endsWith("sample.md"));
});

exports.run = async function run() {
  const ext = vscode.extensions.getExtension("local.live-markdown");
  assert.ok(ext, "extension is installed in the test instance");
  provider = (await ext.activate()).provider;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${t.name}\n      ${String(err && err.stack || err).split("\n").slice(0, 4).join("\n      ")}`);
    }
  }
  await vscode.commands.executeCommand("workbench.action.files.revert").then(undefined, () => {});
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed) throw new Error(`${failed} test(s) failed`);
};
