// Messaging with the extension host, plus caches for things only the host can
// answer (resolving [[links]] and ![[embeds]] against the workspace).
import type { HostToWebview, WebviewToHost, EmbedInfo } from "../src/protocol";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

export function post(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

let nextRequestId = 1;
const pending = new Map<number, (result: unknown) => void>();

export function request<T>(msg: WebviewToHost & { requestId?: number }): Promise<T> {
  const requestId = nextRequestId++;
  post({ ...msg, requestId } as WebviewToHost);
  return new Promise<T>((resolve) => pending.set(requestId, resolve as (r: unknown) => void));
}

export function settleResponse(msg: Extract<HostToWebview, { type: "response" }>): void {
  pending.get(msg.requestId)?.(msg.result);
  pending.delete(msg.requestId);
}

// ---- workspace knowledge -------------------------------------------------

export const workspace = {
  baseUri: "",
  noteNames: new Set<string>(),
  noteList: [] as string[],
};

export function setNoteNames(names: string[]): void {
  workspace.noteList = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  workspace.noteNames = new Set(names.map((n) => n.toLowerCase()));
}

/** Whether a [[target]] resolves to an existing note (used to fade unresolved links). */
export function noteExists(target: string): boolean {
  const name = target.split(/[#^]/)[0].trim();
  if (!name) return true; // [[#heading]] links to the current note
  const base = name.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();
  return workspace.noteNames.has(base) || workspace.noteNames.has(name.toLowerCase());
}

const embedCache = new Map<string, Promise<EmbedInfo>>();
/** Already-settled lookups, so recreated widgets can render synchronously without flicker. */
export const settledEmbeds = new Map<string, EmbedInfo>();

export function resolveEmbed(target: string): Promise<EmbedInfo> {
  let p = embedCache.get(target);
  if (!p) {
    p = request<EmbedInfo>({ type: "resolveEmbed", target });
    p.then((info) => settledEmbeds.set(target, info));
    embedCache.set(target, p);
  }
  return p;
}

export function clearEmbedCache(): void {
  embedCache.clear();
  settledEmbeds.clear();
}

/** Resolve a markdown image src relative to the open file. */
export function resolveImageSrc(src: string): string {
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  try {
    return new URL(src.replace(/^<|>$/g, ""), workspace.baseUri).toString();
  } catch {
    return src;
  }
}
