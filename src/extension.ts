import * as vscode from "vscode";
import { LiveMarkdownEditorProvider, VIEW_TYPE, readConfig } from "./editorProvider";
import { NoteIndex } from "./notes";

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Live Markdown");
  const notes = new NoteIndex();
  const provider = new LiveMarkdownEditorProvider(context.extensionUri, notes, log);

  context.subscriptions.push(
    log,
    notes,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    notes.onDidChange(async (kind) => {
      if (kind === "names") provider.broadcast({ type: "noteNames", noteNames: await notes.names() });
      else provider.broadcast({ type: "filesChanged" });
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("liveMarkdown")) provider.broadcast({ type: "config", config: readConfig() });
    }),
    vscode.commands.registerCommand("liveMarkdown.toggleSourceMode", () => {
      provider.active?.post({ type: "toggleSourceMode" });
    }),
    vscode.commands.registerCommand("liveMarkdown.openSource", (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : provider.active?.document.uri;
      if (target) return vscode.commands.executeCommand("vscode.openWith", target, "default");
    }),
    vscode.commands.registerCommand("liveMarkdown.openLivePreview", (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (target) return vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
    }),
  );

  // Exposed for the integration tests.
  return { provider };
}

export function deactivate() {}
