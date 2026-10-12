import type { TextChange } from "./protocol";

/** The webview always works with "\n" line endings; VS Code documents may use "\r\n". */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Apply one CodeMirror transaction's changes to a string. Positions are
 * relative to the text before the transaction, ascending and non-overlapping,
 * so they're applied back to front.
 */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = text;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return out;
}
