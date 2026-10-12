import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import type { EditorConfig, HostToWebview, TextChange, WebviewToHost } from "./protocol";
import { applyChanges, normalizeEol } from "./sync";
import type { NoteIndex } from "./notes";

export const VIEW_TYPE = "liveMarkdown.editor";

export function readConfig(): EditorConfig {
  const c = vscode.workspace.getConfiguration("liveMarkdown");
  return {
    look: c.get<"minimal" | "default">("look", "minimal"),
    colorScheme: c.get<"obsidian" | "vscode">("colorScheme", "obsidian"),
    fontSize: c.get("fontSize", 16),
    fontFamily: c.get("fontFamily", ""),
    monospaceFontFamily: c.get("monospaceFontFamily", ""),
    readableLineLength: c.get("readableLineLength", true),
    lineWidth: c.get("lineWidth", 700),
    showInlineTitle: c.get("showInlineTitle", true),
    accentColor: c.get("accentColor", ""),
    headingColor: c.get("headingColor", ""),
    headingColors: c.get("headingColors", {}),
  };
}

function openWith(uri: vscode.Uri, newTab: boolean): Thenable<unknown> {
  const column = newTab ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  return /\.(md|markdown)$/i.test(uri.path)
    ? vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, column)
    : vscode.commands.executeCommand("vscode.open", uri, column);
}

/** One open Live Markdown editor: a webview kept in sync with a TextDocument. */
export class EditorSession implements vscode.Disposable {
  /** The text the webview currently shows ("\n" line endings). */
  private shadow: string;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly testWaiters = new Map<number, (result: unknown) => void>();
  private nextTestId = 1;
  private readyResolve!: () => void;
  readonly ready = new Promise<void>((resolve) => (this.readyResolve = resolve));

  constructor(
    readonly document: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly notes: NoteIndex,
    private readonly log: vscode.OutputChannel,
  ) {
    this.shadow = normalizeEol(document.getText());
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, "media"),
        vscode.Uri.joinPath(document.uri, ".."),
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
      ],
    };
    webview.html = this.html();

    webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m), null, this.disposables);
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === document && e.contentChanges.length && this.pending === 0) this.reconcile();
    }, null, this.disposables);
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.document === document && this.pending > 0) e.waitUntil(this.queue);
    }, null, this.disposables);
  }

  post(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  /** Ask the webview for a snapshot of what it renders (used by the integration tests). */
  query(): Promise<unknown> {
    const requestId = this.nextTestId++;
    this.post({ type: "testQuery", requestId });
    return new Promise((resolve) => this.testWaiters.set(requestId, resolve));
  }

  /** Resolves once every edit received from the webview has been applied to the document. */
  flushed(): Promise<void> {
    return this.queue;
  }

  private async sendInit(): Promise<void> {
    this.shadow = normalizeEol(this.document.getText());
    const docDir = vscode.Uri.joinPath(this.document.uri, "..");
    this.post({
      type: "init",
      text: this.shadow,
      fileName: path.posix.basename(this.document.uri.path).replace(/\.(md|markdown)$/i, ""),
      baseUri: `${this.panel.webview.asWebviewUri(docDir).toString()}/`,
      noteNames: await this.notes.names(),
      config: readConfig(),
    });
    this.readyResolve();
  }

  /** Apply edits made in the webview to the document, strictly in order. */
  private enqueueEdit(changes: TextChange[]): void {
    this.shadow = applyChanges(this.shadow, changes);
    this.pending++;
    this.queue = this.queue
      .then(async () => {
        const edit = new vscode.WorkspaceEdit();
        for (const c of changes) {
          edit.replace(this.document.uri, new vscode.Range(c.fromLine, c.fromCol, c.toLine, c.toCol), c.insert);
        }
        if (!(await vscode.workspace.applyEdit(edit))) this.log.appendLine(`applyEdit was rejected for ${this.document.uri}`);
      })
      .catch((err) => this.log.appendLine(`applyEdit failed: ${err}`))
      .finally(() => {
        if (--this.pending === 0) this.reconcile();
      });
  }

  /** If the document changed outside the webview (another editor, git, undo from VS Code), push the new text. */
  private reconcile(): void {
    const text = normalizeEol(this.document.getText());
    if (text !== this.shadow) {
      this.shadow = text;
      this.post({ type: "update", text });
    }
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
          await this.sendInit();
          break;
        case "edit":
          this.enqueueEdit(m.changes);
          break;
        case "openLink":
          await this.openLink(m.href, m.newTab);
          break;
        case "openWikiLink":
          await this.openWikiLink(m.target, m.newTab);
          break;
        case "resolveEmbed": {
          const result = await this.notes.resolveEmbed(m.target, this.document.uri, this.panel.webview);
          this.post({ type: "response", requestId: m.requestId!, result });
          break;
        }
        case "resolveImage": {
          let name = m.src;
          try { name = decodeURIComponent(m.src); } catch { /* keep as-is */ }
          const uri = await this.notes.findFile(name.replace(/^<|>$/g, ""), this.document.uri);
          this.post({ type: "response", requestId: m.requestId!, result: uri ? this.panel.webview.asWebviewUri(uri).toString() : null });
          break;
        }
        case "copyText":
          await vscode.env.clipboard.writeText(m.text);
          break;
        case "log":
          this.log.appendLine(`[webview ${m.level}] ${m.message}`);
          break;
        case "testResult":
          this.testWaiters.get(m.requestId)?.(m.result);
          this.testWaiters.delete(m.requestId);
          break;
      }
    } catch (err) {
      this.log.appendLine(`Error handling ${m.type}: ${err}`);
    }
  }

  private async openLink(href: string, newTab: boolean): Promise<void> {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    let target = href.split("#")[0];
    try { target = decodeURIComponent(target); } catch { /* keep as-is */ }
    target = target.replace(/^<|>$/g, "");
    if (!target) return;
    const docDir = vscode.Uri.joinPath(this.document.uri, "..");
    const root = vscode.workspace.getWorkspaceFolder(this.document.uri)?.uri ?? docDir;
    const uri = /^file:/i.test(target) ? vscode.Uri.parse(target)
      : target.startsWith("/") ? vscode.Uri.joinPath(root, target) : vscode.Uri.joinPath(docDir, target);
    try {
      await vscode.workspace.fs.stat(uri);
      await openWith(uri, newTab);
    } catch {
      const note = await this.notes.findNote(path.posix.basename(target), this.document.uri);
      if (note) await openWith(note, newTab);
      else void vscode.window.showWarningMessage(`Live Markdown: couldn't find “${target}”.`);
    }
  }

  private async openWikiLink(target: string, newTab: boolean): Promise<void> {
    const name = target.split(/[#^|]/)[0].trim();
    if (!name) return;
    const ext = path.posix.extname(name).toLowerCase();
    if (ext && ext !== ".md" && ext !== ".markdown") {
      const file = await this.notes.findFile(name, this.document.uri);
      if (file) await openWith(file, newTab);
      else void vscode.window.showWarningMessage(`Live Markdown: couldn't find “${name}”.`);
      return;
    }
    let uri = await this.notes.findNote(name, this.document.uri);
    if (!uri) {
      // Like Obsidian, following a link to a note that doesn't exist creates it.
      const docDir = vscode.Uri.joinPath(this.document.uri, "..");
      const root = vscode.workspace.getWorkspaceFolder(this.document.uri)?.uri ?? docDir;
      uri = vscode.Uri.joinPath(name.includes("/") ? root : docDir, ext ? name : `${name}.md`);
      try {
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
        this.notes.add(uri);
      } catch (err) {
        void vscode.window.showErrorMessage(`Live Markdown: couldn't create “${name}”: ${err}`);
        return;
      }
    }
    await openWith(uri, newTab);
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", p)).toString();
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data: blob:`,
      `media-src ${webview.cspSource} https: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media("webview.css")}">
  <title>Live Markdown</title>
</head>
<body>
  <div id="app" data-mathjax="${media("mathjax/tex-svg-full.js")}" data-mermaid="${media("mermaid.min.js")}"><div id="editor"></div></div>
  <script nonce="${nonce}" src="${media("webview.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

export class LiveMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  readonly sessions = new Set<EditorSession>();
  private lastActive: EditorSession | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly notes: NoteIndex,
    private readonly log: vscode.OutputChannel,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const session = new EditorSession(document, panel, this.extensionUri, this.notes, this.log);
    this.sessions.add(session);
    this.lastActive = session;
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) this.lastActive = session; });
    panel.onDidDispose(() => {
      this.sessions.delete(session);
      if (this.lastActive === session) this.lastActive = undefined;
      session.dispose();
    });
  }

  get active(): EditorSession | undefined {
    for (const s of this.sessions) if (s.panel.active) return s;
    return this.lastActive;
  }

  sessionFor(uri: vscode.Uri): EditorSession | undefined {
    for (const s of this.sessions) if (s.document.uri.toString() === uri.toString()) return s;
    return undefined;
  }

  broadcast(msg: HostToWebview): void {
    for (const s of this.sessions) s.post(msg);
  }
}
