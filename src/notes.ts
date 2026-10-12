// Workspace lookups for [[wikilinks]] and ![[embeds]], resolved the way
// Obsidian resolves them: by file name anywhere in the vault, preferring the
// closest match to the current note.
import * as path from "path";
import * as vscode from "vscode";
import type { EmbedInfo } from "./protocol";
import { normalizeEol } from "./sync";

const EXCLUDE = "**/{node_modules,.git,.obsidian,.trash}/**";
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp", ".avif", ".ico"]);
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".ogg", ".3gp", ".flac", ".webm"]);
const VIDEO = new Set([".mp4", ".mov", ".mkv", ".ogv"]);
const NOTE_EXT = /\.(md|markdown)$/i;

function noteName(uri: vscode.Uri): string {
  return path.posix.basename(uri.path).replace(NOTE_EXT, "");
}

function dirOf(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, "..");
}

/** Pick the candidate nearest to `fromDir`: same folder first, then the shortest path. */
function closest(candidates: vscode.Uri[], fromDir: vscode.Uri): vscode.Uri | undefined {
  const from = fromDir.path.toLowerCase();
  return [...candidates].sort((a, b) => {
    const score = (u: vscode.Uri) => {
      const dir = dirOf(u).path.toLowerCase();
      return (dir === from ? 0 : from.startsWith(dir) || dir.startsWith(from) ? 1 : 2) * 10_000 + u.path.length;
    };
    return score(a) - score(b);
  })[0];
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function escapeGlob(name: string): string {
  return name.replace(/[[\]{}*?!]/g, (c) => `[${c}]`);
}

export class NoteIndex implements vscode.Disposable {
  private notes: vscode.Uri[] = [];
  private loading: Promise<void>;
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly changed = new vscode.EventEmitter<"names" | "content">();
  /** "names" when notes were added/removed, "content" when a note was edited on disk. */
  readonly onDidChange = this.changed.event;

  private contentTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.loading = this.load();
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const contentChanged = () => {
      clearTimeout(this.contentTimer);
      this.contentTimer = setTimeout(() => this.changed.fire("content"), 300);
    };
    const onAddRemove = (uri: vscode.Uri) => {
      if (/[\\/](node_modules|\.git)[\\/]/.test(uri.path)) return;
      if (!NOTE_EXT.test(uri.path)) {
        contentChanged(); // an attachment appeared/disappeared
        return;
      }
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.loading = this.load().then(() => this.changed.fire("names"));
      }, 300);
    };
    this.watcher.onDidCreate(onAddRemove);
    this.watcher.onDidDelete(onAddRemove);
    this.watcher.onDidChange((uri) => { if (NOTE_EXT.test(uri.path)) contentChanged(); });
  }

  private async load(): Promise<void> {
    this.notes = await vscode.workspace.findFiles("**/*.{md,markdown}", EXCLUDE, 50_000);
  }

  async names(): Promise<string[]> {
    await this.loading;
    return [...new Set(this.notes.map(noteName))];
  }

  add(uri: vscode.Uri): void {
    if (!this.notes.some((u) => u.toString() === uri.toString())) this.notes.push(uri);
    this.changed.fire("names");
  }

  /** Resolve the note part of a [[link]] (no #heading). */
  async findNote(target: string, fromDoc: vscode.Uri): Promise<vscode.Uri | undefined> {
    await this.loading;
    const name = target.trim();
    if (!name) return fromDoc;
    const fromDir = dirOf(fromDoc);
    if (name.includes("/")) {
      const rel = NOTE_EXT.test(name) ? name : `${name}.md`;
      const roots = [fromDir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
      for (const root of roots) {
        const uri = vscode.Uri.joinPath(root, rel);
        if (await exists(uri)) return uri;
      }
      const suffix = `/${rel.toLowerCase()}`;
      return closest(this.notes.filter((u) => u.path.toLowerCase().endsWith(suffix)), fromDir);
    }
    const lower = name.toLowerCase().replace(NOTE_EXT, "");
    return closest(this.notes.filter((u) => noteName(u).toLowerCase() === lower), fromDir);
  }

  /** Find a non-note file (image, pdf, …) by name: next to the note first, then anywhere. */
  async findFile(name: string, fromDoc: vscode.Uri): Promise<vscode.Uri | undefined> {
    const fromDir = dirOf(fromDoc);
    const direct = vscode.Uri.joinPath(fromDir, name);
    if (await exists(direct)) return direct;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const rooted = vscode.Uri.joinPath(folder.uri, name);
      if (await exists(rooted)) return rooted;
    }
    const base = path.posix.basename(name.replace(/\\/g, "/"));
    const hits = await vscode.workspace.findFiles(`**/${escapeGlob(base)}`, EXCLUDE, 50);
    return closest(hits, fromDir);
  }

  async resolveEmbed(target: string, fromDoc: vscode.Uri, webview: vscode.Webview): Promise<EmbedInfo> {
    const name = target.split(/[#^|]/)[0].trim();
    const ext = path.posix.extname(name).toLowerCase();
    if (!ext || NOTE_EXT.test(name)) {
      const uri = await this.findNote(name, fromDoc);
      if (!uri) return { kind: "missing", name };
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const markdown = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      return { kind: "note", uri: uri.toString(), name: noteName(uri), markdown: normalizeEol(markdown) };
    }
    const uri = await this.findFile(name, fromDoc);
    if (!uri) return { kind: "missing", name };
    const kind = IMAGE.has(ext) ? "image" : AUDIO.has(ext) ? "audio" : VIDEO.has(ext) ? "video" : ext === ".pdf" ? "pdf" : "file";
    return { kind, uri: webview.asWebviewUri(uri).toString(), name: path.posix.basename(uri.path) };
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.contentTimer);
    this.watcher.dispose();
    this.changed.dispose();
  }
}
