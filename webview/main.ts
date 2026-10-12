import "./styles.css";
import { Annotation, Compartment, EditorSelection, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, keymap, rectangularSelection, type Command } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, selectAll, undo } from "@codemirror/commands";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
  autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap,
  type CompletionContext, type CompletionResult,
} from "@codemirror/autocomplete";
import { lpTags, obsidianSyntax } from "./syntax";
import { tableCellSetup } from "./tableEditor";
import { inlineTitle, livePreview, livePreviewField, refreshDecorations, resetMeasurements, setLivePreview } from "./livePreview";
import { clearEmbedCache, post, setNoteNames, settleResponse, vscode, workspace } from "./host";
import { icon } from "./icons";
import type { EditorConfig, HostToWebview, TextChange } from "../src/protocol";

const remote = Annotation.define<boolean>();
const titleCompartment = new Compartment();

let view: EditorView | null = null;
let fileName = "";
let config: EditorConfig | null = null;

// ---- error reporting --------------------------------------------------------------

window.addEventListener("error", (e) => post({ type: "log", level: "error", message: `${e.message} (${e.filename}:${e.lineno})` }));
window.addEventListener("unhandledrejection", (e) => post({ type: "log", level: "error", message: `Unhandled rejection: ${e.reason}` }));

// ---- styling -------------------------------------------------------------------------

const highlightStyle = HighlightStyle.define([
  { tag: t.emphasis, class: "lm-em" },
  { tag: t.strong, class: "lm-strong" },
  { tag: t.strikethrough, class: "lm-strike" },
  { tag: lpTags.highlight, class: "lm-highlight" },
  { tag: t.processingInstruction, class: "lm-formatting" },
  { tag: [t.link, t.url], class: "lm-url" },
  { tag: t.monospace, class: "lm-mono" },
  { tag: lpTags.math, class: "lm-math-source" },
  // code block tokens, coloured like Obsidian's default theme
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], class: "tok-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: "tok-string" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "tok-comment" },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], class: "tok-value" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.typeName, t.namespace], class: "tok-function" },
  { tag: [t.propertyName, t.attributeName, t.labelName], class: "tok-property" },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.compareOperator], class: "tok-operator" },
  { tag: [t.tagName, t.angleBracket], class: "tok-tag" },
  { tag: [t.punctuation, t.separator, t.bracket], class: "tok-punctuation" },
  { tag: [t.meta, t.annotation], class: "tok-meta" },
  { tag: t.invalid, class: "tok-invalid" },
]);

function applyConfig(c: EditorConfig): void {
  config = c;
  const root = document.documentElement.style;
  root.setProperty("--font-text-size", `${c.fontSize}px`);
  if (c.fontFamily) root.setProperty("--font-text", c.fontFamily); else root.removeProperty("--font-text");
  if (c.monospaceFontFamily) root.setProperty("--font-monospace", c.monospaceFontFamily); else root.removeProperty("--font-monospace");
  root.setProperty("--file-line-width", `${c.lineWidth}px`);
  if (c.accentColor) root.setProperty("--lm-accent", c.accentColor); else root.removeProperty("--lm-accent");
  if (c.headingColor) root.setProperty("--lm-heading-color", c.headingColor); else root.removeProperty("--lm-heading-color");
  for (let level = 1; level <= 6; level++) {
    const color = c.headingColors?.[`h${level}` as keyof EditorConfig["headingColors"]];
    if (color) root.setProperty(`--lm-h${level}-color`, color); else root.removeProperty(`--lm-h${level}-color`);
  }
  document.body.dataset.scheme = c.colorScheme;
  document.body.dataset.look = c.look;
  document.body.classList.toggle("lm-readable", c.readableLineLength);
  resetMeasurements();
  if (view) {
    view.dispatch({ effects: [titleCompartment.reconfigure(inlineTitle.of(c.showInlineTitle ? fileName : "")), refreshDecorations.of(null)] });
    view.requestMeasure();
  }
}

// ---- formatting commands ----------------------------------------------------------------

function toggleWrap(marker: string): Command {
  return (v) => {
    const { state } = v;
    v.dispatch(state.changeByRange((range) => {
      const n = marker.length;
      if (state.sliceDoc(range.from - n, range.from) === marker && state.sliceDoc(range.to, range.to + n) === marker) {
        return {
          changes: [{ from: range.from - n, to: range.from }, { from: range.to, to: range.to + n }],
          range: EditorSelection.range(range.from - n, range.to - n),
        };
      }
      const text = state.sliceDoc(range.from, range.to);
      if (text.length >= 2 * n && text.startsWith(marker) && text.endsWith(marker)) {
        return {
          changes: { from: range.from, to: range.to, insert: text.slice(n, -n) },
          range: EditorSelection.range(range.from, range.to - 2 * n),
        };
      }
      return {
        changes: [{ from: range.from, insert: marker }, { from: range.to, insert: marker }],
        range: EditorSelection.range(range.from + n, range.to + n),
      };
    }), { userEvent: "input.format", scrollIntoView: true });
    return true;
  };
}

const toggleBold = toggleWrap("**");
const toggleItalic = toggleWrap("*");

// VS Code forwards key presses inside a webview to the workbench, which would
// e.g. run its own Undo against the document (a double undo) or toggle the
// sidebar on Ctrl+B. Keys we own are handled here, before anything else.
const capturedKeys: Record<string, Command> = {
  "mod+z": undo,
  "mod+y": redo,
  "mod+shift+z": redo,
  "mod+a": selectAll,
  "mod+b": toggleBold,
  "mod+i": toggleItalic,
  "mod+f": openSearchPanel,
};

let lastKeyUndo = 0;

window.addEventListener("keydown", (e) => {
  if (!view || !view.contentDOM.contains(e.target as Node)) return;
  const key = `${e.ctrlKey || e.metaKey ? "mod+" : ""}${e.shiftKey ? "shift+" : ""}${e.altKey ? "alt+" : ""}${e.key.toLowerCase()}`;
  const command = capturedKeys[key];
  if (!command) return;
  // Table cells are small editors of their own: formatting and select-all act on the
  // cell, while undo/redo (one history for the whole note) and find act on the note.
  const inner = (e.target as HTMLElement).closest?.<HTMLElement>(".cm-editor");
  const target = command === undo || command === redo || command === openSearchPanel ? view
    : (inner && EditorView.findFromDOM(inner)) || view;
  if (command(target)) {
    if (command === undo || command === redo) lastKeyUndo = performance.now();
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

// Belt and braces: if VS Code still runs its Undo for the same key press, it
// arrives as a native "historyUndo" input event right after ours — drop it.
const ignoreEchoedUndo = Prec.highest(EditorView.domEventHandlers({
  beforeinput(e) {
    if ((e.inputType === "historyUndo" || e.inputType === "historyRedo") && performance.now() - lastKeyUndo < 500) {
      e.preventDefault();
      return true;
    }
    return false;
  },
}));

/** In a table cell editor, the browser's own undo goes to the note's history instead. */
const cellUndoToNote = Prec.highest(EditorView.domEventHandlers({
  beforeinput(e) {
    if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return false;
    e.preventDefault();
    if (view && performance.now() - lastKeyUndo >= 500) (e.inputType === "historyUndo" ? undo : redo)(view);
    return true;
  },
}));

// ---- [[ link autocompletion -----------------------------------------------------------

function wikiLinkCompletions(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/!?\[\[[^\][|#\n]*$/);
  if (!m) return null;
  const from = m.from + m.text.indexOf("[[") + 2;
  return {
    from,
    validFor: /^[^\][|#\n]*$/,
    options: workspace.noteList.map((name) => ({
      label: name,
      type: "text",
      apply: (v: EditorView, _c: unknown, f: number, to: number) => {
        const closed = v.state.sliceDoc(to, to + 2) === "]]";
        v.dispatch({
          changes: { from: f, to, insert: closed ? name : `${name}]]` },
          selection: { anchor: f + name.length + 2 },
          userEvent: "input.complete",
        });
      },
    })),
  };
}

// ---- editor --------------------------------------------------------------------------

function changesOf(tr: Transaction): TextChange[] {
  const changes: TextChange[] = [];
  const doc = tr.startState.doc;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const a = doc.lineAt(fromA), b = doc.lineAt(toA);
    changes.push({
      from: fromA, to: toA,
      fromLine: a.number - 1, fromCol: fromA - a.from,
      toLine: b.number - 1, toCol: toA - b.from,
      insert: inserted.toString(),
    });
  });
  return changes;
}

/** Markdown parsing, highlighting and editing helpers shared by the note and table cells. */
function markdownEditing() {
  return [
    markdown({ base: commonmarkLanguage, extensions: [GFM, ...obsidianSyntax], codeLanguages: languages, addKeymap: true }),
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{"] } }]),
    syntaxHighlighting(highlightStyle),
    closeBrackets(),
    autocompletion({ override: [wikiLinkCompletions], icons: false }),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" }),
  ];
}

const cellEditorSetup = [
  cellUndoToNote,
  drawSelection(),
  markdownEditing(),
  keymap.of([
    ...closeBracketsKeymap,
    ...completionKeymap,
    { key: "Mod-b", run: toggleBold },
    { key: "Mod-i", run: toggleItalic },
    ...defaultKeymap,
  ]),
  livePreview(),
];

function createEditor(text: string, sourceMode: boolean): EditorView {
  const state = EditorState.create({
    doc: text,
    extensions: [
      ignoreEchoedUndo,
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      EditorState.allowMultipleSelections.of(true),
      indentUnit.of("\t"),
      EditorState.tabSize.of(4),
      markdownEditing(),
      tableCellSetup.of(cellEditorSetup),
      search({ top: true }),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...searchKeymap,
        ...historyKeymap,
        { key: "Mod-b", run: toggleBold },
        { key: "Mod-i", run: toggleItalic },
        indentWithTab,
        ...defaultKeymap,
      ]),
      titleCompartment.of(inlineTitle.of(config?.showInlineTitle === false ? "" : fileName)),
      livePreview(),
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) {
          if (tr.docChanged && !tr.annotation(remote)) post({ type: "edit", changes: changesOf(tr) });
        }
      }),
    ],
  });
  const v = new EditorView({ state, parent: document.getElementById("editor")! });
  if (sourceMode) v.dispatch({ effects: setLivePreview.of(false) });
  return v;
}

/** Bring the editor in line with text changed outside the webview, keeping the cursor. */
function applyRemoteText(text: string): void {
  if (!view) return;
  const cur = view.state.doc.toString();
  if (cur === text) return;
  let start = 0;
  const max = Math.min(cur.length, text.length);
  while (start < max && cur.charCodeAt(start) === text.charCodeAt(start)) start++;
  let endCur = cur.length, endNew = text.length;
  while (endCur > start && endNew > start && cur.charCodeAt(endCur - 1) === text.charCodeAt(endNew - 1)) { endCur--; endNew--; }
  view.dispatch({
    changes: { from: start, to: endCur, insert: text.slice(start, endNew) },
    annotations: [remote.of(true), Transaction.addToHistory.of(false)],
  });
}

// ---- mode switch (Live Preview <-> Source mode) ------------------------------------------

const modeButton = document.createElement("button");
modeButton.className = "lm-mode-toggle";
modeButton.addEventListener("mousedown", (e) => e.preventDefault());
modeButton.addEventListener("click", () => toggleSourceMode());
document.body.append(modeButton);

function renderModeButton(): void {
  const live = view?.state.field(livePreviewField) ?? true;
  modeButton.replaceChildren(icon(live ? "book-open" : "code-xml"), document.createTextNode(live ? "Live Preview" : "Source mode"));
  modeButton.title = live ? "Switch to Source mode" : "Switch to Live Preview";
}

function toggleSourceMode(): void {
  if (!view) return;
  const live = !view.state.field(livePreviewField);
  view.dispatch({ effects: setLivePreview.of(live) });
  vscode.setState({ sourceMode: !live });
  renderModeButton();
}

// ---- test hook (used by the integration tests) --------------------------------------------

function testSnapshot() {
  const q = (sel: string) => document.querySelectorAll(sel).length;
  return {
    text: view?.state.doc.toString() ?? null,
    livePreview: view?.state.field(livePreviewField) ?? null,
    counts: {
      headings: q(".lm-heading"), hiddenHeaderMarks: q(".lm-h1 .lm-formatting"),
      checkboxes: q(".lm-task-checkbox"), callouts: q(".lm-callout"), tables: q(".lm-table"),
      math: q(".lm-math, .lm-math-block"), internalLinks: q(".lm-internal-link"), bullets: q(".lm-list-bullet"),
      tags: q(".lm-tag"), properties: q(".lm-properties"), inlineTitle: q(".lm-inline-title"),
      calloutFolds: q(".lm-callout-fold"), collapsedCallouts: q(".lm-callout-fold.is-collapsed"), activeCells: q(".lm-cell-active"),
    },
    renderedText: view?.contentDOM.textContent ?? "",
    headingColor: getComputedStyle(document.documentElement).getPropertyValue("--lm-heading-color"),
    firstLineText: document.querySelector(".cm-line")?.textContent ?? null,
  };
}

// ---- messages from the extension host --------------------------------------------------

window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init": {
      fileName = msg.fileName;
      workspace.baseUri = msg.baseUri;
      setNoteNames(msg.noteNames);
      applyConfig(msg.config);
      view?.destroy();
      const saved = vscode.getState() as { sourceMode?: boolean } | undefined;
      view = createEditor(msg.text, msg.sourceMode ?? saved?.sourceMode ?? false);
      renderModeButton();
      view.focus();
      break;
    }
    case "update":
      applyRemoteText(msg.text);
      break;
    case "config":
      applyConfig(msg.config);
      break;
    case "noteNames":
      setNoteNames(msg.noteNames);
      view?.dispatch({ effects: refreshDecorations.of(null) });
      break;
    case "filesChanged":
      clearEmbedCache();
      view?.dispatch({ effects: refreshDecorations.of(null) });
      break;
    case "toggleSourceMode":
      toggleSourceMode();
      break;
    case "response":
      settleResponse(msg);
      break;
    case "testQuery":
      post({ type: "testResult", requestId: msg.requestId, result: testSnapshot() });
      break;
    case "testType": {
      // Same path as a keystroke: a user transaction that the update listener forwards.
      // Without a position, types at the cursor of the table cell being edited.
      const cell = document.querySelector<HTMLElement>(".lm-cell-active .cm-editor");
      const target = msg.at === undefined && cell ? EditorView.findFromDOM(cell) : view;
      if (!target) break;
      if (msg.at === undefined) target.dispatch(target.state.replaceSelection(msg.text), { userEvent: "input.type" });
      else target.dispatch({ changes: { from: msg.at, insert: msg.text }, userEvent: "input.type" });
      break;
    }
    case "testClick": {
      const el = document.querySelectorAll<HTMLElement>(msg.selector)[msg.index ?? 0];
      if (!el) break;
      const r = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      el.dispatchEvent(new MouseEvent("mousedown", init));
      el.dispatchEvent(new MouseEvent("mouseup", init));
      el.dispatchEvent(new MouseEvent("click", init));
      break;
    }
    case "testKey": {
      const target = document.querySelector(".lm-cell-active .cm-content") ?? view?.contentDOM;
      target?.dispatchEvent(new KeyboardEvent("keydown", { key: msg.key, shiftKey: !!msg.shift, bubbles: true, cancelable: true }));
      break;
    }
    case "testScrollTo": {
      const pos = view?.state.doc.toString().indexOf(msg.text) ?? -1;
      if (view && pos >= 0) view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      break;
    }
  }
});

post({ type: "ready" });
