// Messages exchanged between the extension host and the editor webview.

export interface EditorConfig {
  look: "minimal" | "default";
  colorScheme: "obsidian" | "vscode";
  fontSize: number;
  fontFamily: string;
  monospaceFontFamily: string;
  readableLineLength: boolean;
  lineWidth: number;
  showInlineTitle: boolean;
  accentColor: string;
  headingColor: string;
  headingColors: { h1?: string; h2?: string; h3?: string; h4?: string; h5?: string; h6?: string };
}

/** One change from a CodeMirror transaction, in both offset and line/column form. */
export interface TextChange {
  from: number;
  to: number;
  fromLine: number;
  fromCol: number;
  toLine: number;
  toCol: number;
  insert: string;
}

export type EmbedInfo =
  | { kind: "image" | "audio" | "video" | "pdf" | "file"; uri: string; name: string }
  | { kind: "note"; uri: string; name: string; markdown: string }
  | { kind: "missing"; name: string };

export type HostToWebview =
  | { type: "init"; text: string; fileName: string; baseUri: string; noteNames: string[]; config: EditorConfig; sourceMode?: boolean }
  | { type: "update"; text: string }
  | { type: "config"; config: EditorConfig }
  | { type: "noteNames"; noteNames: string[] }
  | { type: "filesChanged" }
  | { type: "toggleSourceMode" }
  | { type: "response"; requestId: number; result: unknown }
  | { type: "testQuery"; requestId: number }
  | { type: "testType"; at?: number; text: string }
  | { type: "testClick"; selector: string; index?: number }
  | { type: "testKey"; key: string; shift?: boolean }
  | { type: "testScrollTo"; text: string };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "edit"; changes: TextChange[] }
  | { type: "openLink"; href: string; newTab: boolean }
  | { type: "openWikiLink"; target: string; newTab: boolean }
  | { type: "resolveEmbed"; target: string; requestId?: number }
  | { type: "resolveImage"; src: string; requestId?: number }
  | { type: "copyText"; text: string }
  | { type: "log"; level: "info" | "error"; message: string }
  | { type: "testResult"; requestId: number; result: unknown };
