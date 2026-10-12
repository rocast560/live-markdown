// Obsidian-style Live Preview for CodeMirror 6.
//
// Markdown syntax is hidden (or swapped for a rendered widget) unless the
// selection touches it – the same rule Obsidian's editor uses:
//   * inline formatting (bold, links, code, math…) reveals when the cursor is
//     inside or at the edge of that element;
//   * line syntax (heading #, quote >, hr) reveals when the cursor is on the line;
//   * blocks (tables, $$ math $$, mermaid, frontmatter) render as widgets and
//     switch back to source when the cursor enters them.
import { EditorState, Facet, MapMode, Range, StateEffect, StateField, type Extension, type Line } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { findFrontmatter } from "./syntax";
import { calloutStyle, icon } from "./icons";
import { noteExists } from "./host";
import {
  CalloutTitleWidget, CheckboxWidget, CodeHeaderWidget, EmbedWidget, ExternalLinkIconWidget, HrWidget,
  ImageWidget, InlineTitleWidget, MathWidget, MermaidWidget, PropertiesWidget, TextWidget,
  followLink, parseSize,
} from "./widgets";
import { TableWidget, parseTable, tableEditing } from "./tableEditor";

export const setLivePreview = StateEffect.define<boolean>();
export const refreshDecorations = StateEffect.define<null>();

export const livePreviewField = StateField.define<boolean>({
  create: () => true,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLivePreview)) value = e.value;
    return value;
  },
});

export const inlineTitle = Facet.define<string, string>({ combine: (v) => (v.length ? v[v.length - 1] : "") });

const frontmatterField = StateField.define({
  create: (state: EditorState) => findFrontmatter(state.doc.sliceString(0, 100_000)),
  update: (value, tr) => (tr.docChanged ? findFrontmatter(tr.state.doc.sliceString(0, 100_000)) : value),
});

function touches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function needsRebuild(u: { docChanged: boolean; startState: EditorState; state: EditorState; transactions: readonly { effects: readonly StateEffect<unknown>[]; selection?: unknown }[] }): boolean {
  return u.docChanged
    || u.transactions.some((t) => t.selection !== undefined
      || t.effects.some((e) => e.is(setLivePreview) || e.is(refreshDecorations) || e.is(toggleCalloutFold)))
    || syntaxTree(u.startState) !== syntaxTree(u.state);
}

const hidden = Decoration.replace({});
const hrWidget = new HrWidget();
const externalIcon = new ExternalLinkIconWidget();

// ---- text measurement for hanging list indents ----------------------------------

let measureCtx: CanvasRenderingContext2D | null = null;
let measureFont = "";
let measureCache = new Map<string, number>();

export function resetMeasurements(): void {
  measureFont = "";
}

function textWidth(view: EditorView, text: string): number {
  if (!measureFont) {
    const cs = getComputedStyle(view.contentDOM);
    measureFont = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    measureCtx ??= document.createElement("canvas").getContext("2d");
    if (measureCtx) measureCtx.font = measureFont;
    measureCache = new Map();
  }
  let w = measureCache.get(text);
  if (w === undefined) {
    const expanded = text.replace(/\t/g, " ".repeat(view.state.tabSize));
    w = measureCtx ? measureCtx.measureText(expanded).width : expanded.length * 8;
    measureCache.set(text, w);
  }
  return w;
}

// ---- callout folding ------------------------------------------------------------------

/** Callouts the user folded or unfolded, keyed by the start of the callout's first line. */
export const toggleCalloutFold = StateEffect.define<{ line: number; folded: boolean }>();

const calloutFolds = StateField.define<ReadonlyMap<number, boolean>>({
  create: () => new Map(),
  update(folds, tr) {
    if (tr.docChanged && folds.size) {
      const mapped = new Map<number, boolean>();
      for (const [pos, folded] of folds) {
        const to = tr.changes.mapPos(pos, 1, MapMode.TrackDel);
        if (to !== null) mapped.set(to, folded);
      }
      folds = mapped;
    }
    for (const e of tr.effects) if (e.is(toggleCalloutFold)) folds = new Map(folds).set(e.value.line, e.value.folded);
    return folds;
  },
});

/**
 * As in Obsidian, `> [!type]-` starts folded and `> [!type]+` starts open; clicking the
 * chevron toggles either (without touching the file). A folded body still shows while
 * the cursor is in it.
 */
function calloutFold(state: EditorState, first: Line, sign: string, to: number): { foldable: boolean; folded: boolean } {
  const foldable = sign === "+" || sign === "-";
  if (!foldable || to <= first.to || !state.field(livePreviewField)) return { foldable, folded: false };
  const folded = state.field(calloutFolds).get(first.from) ?? sign === "-";
  return { foldable, folded: folded && !touches(state, first.to + 1, to) };
}

function toggleCalloutAt(view: EditorView, pos: number): void {
  const { state } = view;
  const line = state.doc.lineAt(pos);
  let quote: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (n) => {
      if (quote || n.name !== "Blockquote") return !quote;
      if (state.doc.lineAt(n.from).number === line.number) quote = { from: n.from, to: n.to };
      return false;
    },
  });
  if (!quote) return;
  const { from, to } = quote;
  const m = CALLOUT_RE.exec(state.doc.sliceString(from, line.to));
  if (!m) return;
  const folded = !calloutFold(state, line, m[3], to).folded;
  view.dispatch({
    effects: toggleCalloutFold.of({ line: line.from, folded }),
    // Folding with the cursor inside the body: park it on the title line.
    selection: folded && touches(state, line.to + 1, to) ? { anchor: line.to } : undefined,
  });
}

class CalloutFoldWidget extends WidgetType {
  constructor(readonly folded: boolean) { super(); }
  eq(other: CalloutFoldWidget) { return other.folded === this.folded; }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = `lm-callout-fold${this.folded ? " is-collapsed" : ""}`;
    span.title = this.folded ? "Expand" : "Collapse";
    span.append(icon("chevron-down"));
    span.addEventListener("mousedown", (e) => e.preventDefault());
    span.addEventListener("click", (e) => {
      e.preventDefault();
      toggleCalloutAt(view, view.posAtDOM(span));
    });
    return span;
  }
  ignoreEvent() { return true; }
}

// ---- inline / line decorations (viewport only) ------------------------------------

const CALLOUT_RE = /^(\s*>\s*)\[!([^\]\s]+)\]([+-]?)[ \t]*(.*)$/;
const EMPHASIS_MARKS: Record<string, string> = {
  Emphasis: "EmphasisMark", StrongEmphasis: "EmphasisMark", Strikethrough: "StrikethroughMark", Highlight: "HighlightMark",
};
const LINKISH_PARENTS = new Set(["Link", "Image", "Autolink", "LinkReference"]);

function buildInline(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const live = state.field(livePreviewField);
  const fm = state.field(frontmatterField);
  const out: Range<Decoration>[] = [];
  const { from: vpFrom, to: vpTo } = view.viewport;
  const calloutTitleLines = new Set<number>();
  // Callout bodies pull their (transparent) "> " into the left padding.
  view.dom.style.setProperty("--lm-quote-w", `${textWidth(view, "> ").toFixed(1)}px`);

  const touched =(n: { from: number; to: number }) => touches(state, n.from, n.to);
  const lineActive = (pos: number) => { const l = doc.lineAt(pos); return touches(state, l.from, l.to); };
  const hide = (from: number, to: number) => { if (to > from) out.push(hidden.range(from, to)); };
  const mark = (cls: string, from: number, to: number, attributes?: Record<string, string>) => {
    if (to > from) out.push(Decoration.mark({ class: cls, attributes }).range(from, to));
  };
  const lineDeco = (line: Line, cls: string, attributes?: Record<string, string>) =>
    out.push(Decoration.line({ class: cls, attributes }).range(line.from));
  const eachLine = (from: number, to: number, fn: (line: Line, first: boolean, last: boolean) => void) => {
    const first = doc.lineAt(from).number, last = doc.lineAt(Math.max(from, to)).number;
    const start = Math.max(first, doc.lineAt(vpFrom).number), end = Math.min(last, doc.lineAt(vpTo).number);
    for (let n = start; n <= end; n++) fn(doc.line(n), n === first, n === last);
  };

  if (fm) eachLine(fm.from, fm.to, (l) => lineDeco(l, "lm-frontmatter-line"));

  syntaxTree(state).iterate({
    from: vpFrom,
    to: vpTo,
    enter: (ref) => {
      if (fm && ref.name !== "Document" && ref.from < fm.to && ref.to <= fm.to) return false;
      const node = ref.node;
      switch (ref.name) {
        case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
        case "ATXHeading4": case "ATXHeading5": case "ATXHeading6": {
          const level = Number(ref.name.slice(-1));
          lineDeco(doc.lineAt(ref.from), `lm-heading lm-h${level}`);
          if (live && !lineActive(ref.from)) {
            for (let c = node.firstChild; c; c = c.nextSibling) {
              if (c.name !== "HeaderMark") continue;
              if (c.from === ref.from) {
                let end = c.to;
                while (end < ref.to && /[ \t]/.test(doc.sliceString(end, end + 1))) end++;
                hide(c.from, end);
              } else {
                let start = c.from;
                while (start > ref.from && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
                hide(start, c.to);
              }
            }
          }
          return;
        }
        case "SetextHeading1": case "SetextHeading2": {
          const level = ref.name.endsWith("1") ? 1 : 2;
          const underline = node.getChild("HeaderMark");
          const textEnd = underline ? doc.lineAt(underline.from).from - 1 : ref.to;
          eachLine(ref.from, Math.max(ref.from, textEnd), (l) => lineDeco(l, `lm-heading lm-h${level}`));
          if (underline && live && !touched(ref)) {
            hide(underline.from, underline.to);
            lineDeco(doc.lineAt(underline.from), "lm-collapsed-line");
          }
          return;
        }
        case "Emphasis": case "StrongEmphasis": case "Strikethrough": case "Highlight": {
          if (live && !touched(ref)) {
            const markName = EMPHASIS_MARKS[ref.name];
            for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === markName) hide(c.from, c.to);
          }
          return;
        }
        case "InlineCode": {
          const marks = node.getChildren("CodeMark");
          if (live && !touched(ref) && marks.length === 2) {
            hide(marks[0].from, marks[0].to);
            hide(marks[1].from, marks[1].to);
            mark("lm-inline-code", marks[0].to, marks[1].from);
          } else {
            mark("lm-inline-code", ref.from, ref.to);
          }
          return false;
        }
        case "Link": {
          const marks = node.getChildren("LinkMark");
          const url = node.getChild("URL");
          if (marks.length < 2 || (!url && !node.getChild("LinkLabel"))) return; // bare [text]
          const textFrom = marks[0].to, textTo = marks[1].from;
          const href = url ? doc.sliceString(url.from, url.to) : "";
          const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
          mark(external ? "lm-link lm-external-link" : "lm-link", textFrom, textTo, href ? { "data-href": href } : undefined);
          if (live && !touched(ref)) {
            hide(ref.from, textFrom);
            if (external) out.push(Decoration.replace({ widget: externalIcon }).range(textTo, ref.to));
            else hide(textTo, ref.to);
          } else if (url) {
            mark("lm-url", url.from, url.to);
          }
          return;
        }
        case "Image": {
          const marks = node.getChildren("LinkMark");
          const url = node.getChild("URL");
          if (!url || marks.length < 2 || !live) return false;
          const altRaw = doc.sliceString(marks[0].to, marks[1].from);
          const pipe = altRaw.lastIndexOf("|");
          const size = pipe >= 0 ? parseSize(altRaw.slice(pipe + 1)) : null;
          const alt = size ? altRaw.slice(0, pipe) : altRaw;
          const widget = new ImageWidget(doc.sliceString(url.from, url.to), alt, size?.width, size?.height);
          if (!touched(ref)) out.push(Decoration.replace({ widget }).range(ref.from, ref.to));
          else out.push(Decoration.widget({ widget, side: 1 }).range(ref.to));
          return false;
        }
        case "Autolink": {
          const url = node.getChild("URL");
          if (!url) return false;
          const href = doc.sliceString(url.from, url.to);
          mark("lm-link lm-external-link", url.from, url.to, { "data-href": /^[^:]+@/.test(href) ? `mailto:${href}` : href });
          if (live && !touched(ref)) { hide(ref.from, url.from); hide(url.to, ref.to); }
          return false;
        }
        case "URL": {
          if (LINKISH_PARENTS.has(node.parent?.name ?? "")) return false;
          const href = doc.sliceString(ref.from, ref.to);
          const target = /^www\./i.test(href) ? `https://${href}` : /^[^:/]+@/.test(href) ? `mailto:${href}` : href;
          mark("lm-link lm-external-link", ref.from, ref.to, { "data-href": target });
          return false;
        }
        case "WikiLink": {
          const target = node.getChild("WikiLinkTarget");
          const alias = node.getChild("WikiLinkAlias");
          const targetText = target ? doc.sliceString(target.from, target.to) : "";
          const shown = alias ?? target;
          if (!shown) return false;
          const cls = noteExists(targetText) ? "lm-internal-link" : "lm-internal-link lm-unresolved";
          mark(cls, shown.from, shown.to, { "data-wiki": targetText });
          if (live && !touched(ref)) {
            hide(ref.from, shown.from);
            hide(shown.to, ref.to);
            if (!alias) {
              // [[Note#Heading]] reads as "Note › Heading", as in Obsidian.
              const hash = targetText.indexOf("#");
              if (hash > 0) out.push(Decoration.replace({ widget: new TextWidget(" › ", "lm-link-sep") }).range(shown.from + hash, shown.from + hash + 1));
            }
          }
          return false;
        }
        case "Embed": {
          if (!live) return false;
          const target = node.getChild("WikiLinkTarget");
          if (!target) return false;
          const alias = node.getChild("WikiLinkAlias");
          const widget = new EmbedWidget(doc.sliceString(target.from, target.to), alias ? doc.sliceString(alias.from, alias.to) : "");
          if (!touched(ref)) out.push(Decoration.replace({ widget }).range(ref.from, ref.to));
          else out.push(Decoration.widget({ widget, side: 1 }).range(ref.to));
          return false;
        }
        case "Tag":
          mark("lm-tag", ref.from, ref.to);
          return false;
        case "InlineMath": {
          const marks = node.getChildren("InlineMathMark");
          if (marks.length < 2) return false;
          if (live && !touched(ref)) {
            const display = marks[0].to - marks[0].from === 2;
            const widget = new MathWidget(doc.sliceString(marks[0].to, marks[1].from), display);
            out.push(Decoration.replace({ widget }).range(ref.from, ref.to));
          } else {
            mark("lm-math-source", ref.from, ref.to);
          }
          return false;
        }
        case "BlockMath":
          eachLine(ref.from, ref.to, (l) => lineDeco(l, "lm-math-source-line"));
          return false;
        case "Comment":
          mark("lm-comment", ref.from, ref.to);
          return false;
        case "FootnoteRef": {
          const marks = node.getChildren("FootnoteMark");
          if (live && !touched(ref) && marks.length === 2) {
            hide(marks[0].from, marks[0].to);
            hide(marks[1].from, marks[1].to);
            mark("lm-footnote-ref", marks[0].to, marks[1].from);
          } else {
            mark("lm-footnote-source", ref.from, ref.to);
          }
          return false;
        }
        case "LinkReference":
          mark("lm-link-reference", ref.from, ref.to);
          return false;
        case "Escape":
          if (live && !touched(ref)) hide(ref.from, ref.from + 1);
          return false;
        case "HorizontalRule":
          lineDeco(doc.lineAt(ref.from), "lm-hr-line");
          if (live && !lineActive(ref.from)) out.push(Decoration.replace({ widget: hrWidget }).range(ref.from, ref.to));
          return false;
        case "Blockquote": {
          const first = doc.lineAt(ref.from);
          const m = node.parent?.name === "Blockquote" ? null : CALLOUT_RE.exec(doc.sliceString(ref.from, first.to));
          if (!m) {
            eachLine(ref.from, ref.to, (l) => lineDeco(l, "lm-quote"));
            return;
          }
          const type = m[2].toLowerCase();
          const style = calloutStyle(type);
          const fold = calloutFold(state, first, m[3], ref.to);
          eachLine(ref.from, ref.to, (l, isFirst, isLast) => {
            // A folded callout is just its title line, so that line gets the bottom edge too.
            const last = isLast || (isFirst && fold.folded);
            lineDeco(l, `lm-callout${isFirst ? " lm-callout-first" : ""}${last ? " lm-callout-last" : ""}${isFirst && fold.folded ? " lm-callout-folded" : ""}`,
              { style: `--callout-color: ${style.color}`, "data-callout": type });
          });
          const titleFrom = ref.from + m[0].length - m[4].length;
          calloutTitleLines.add(first.number);
          if (live && fold.foldable) out.push(Decoration.widget({ widget: new CalloutFoldWidget(fold.folded), side: 1 }).range(first.to));
          if (live && !lineActive(ref.from)) {
            const fallback = m[4] ? "" : type.charAt(0).toUpperCase() + type.slice(1);
            out.push(Decoration.replace({ widget: new CalloutTitleWidget(style.icon, fallback) }).range(ref.from, titleFrom));
          }
          mark("lm-callout-title", titleFrom, first.to);
          return;
        }
        case "QuoteMark": {
          if (!live || lineActive(ref.from)) return false;
          if (calloutTitleLines.has(doc.lineAt(ref.from).number)) return false;
          mark("lm-quote-mark", ref.from, ref.to);
          return false;
        }
        case "ListMark":
          decorateListMark(view, node, live, out, mark, lineDeco);
          return false;
        case "FencedCode": {
          const info = node.getChild("CodeInfo");
          const lang = info ? doc.sliceString(info.from, info.to).trim().split(/\s/)[0].toLowerCase() : "";
          const revealed = !live || touched(ref);
          if (lang === "mermaid" && !revealed && wholeLines(state, ref.from, ref.to)) return false; // rendered by blockField
          const firstLine = doc.lineAt(ref.from), lastLine = doc.lineAt(ref.to);
          const marks = node.getChildren("CodeMark");
          const closing = marks.length >= 2 && doc.lineAt(marks[marks.length - 1].from).number !== firstLine.number
            ? marks[marks.length - 1] : null;
          eachLine(ref.from, ref.to, (l, isFirst, isLast) =>
            lineDeco(l, `lm-codeblock${isFirst ? " lm-codeblock-begin" : ""}${isLast ? " lm-codeblock-end" : ""}`));
          if (!revealed) {
            const bodyFrom = Math.min(firstLine.to + 1, ref.to);
            const bodyTo = closing ? Math.max(bodyFrom, lastLine.from - 1) : ref.to;
            const widget = new CodeHeaderWidget(lang, doc.sliceString(bodyFrom, bodyTo));
            out.push(Decoration.replace({ widget }).range(ref.from, firstLine.to));
            lineDeco(firstLine, "lm-fence-hidden");
            if (closing) {
              hide(closing.from, lastLine.to);
              lineDeco(lastLine, "lm-fence-hidden");
            }
          }
          return false;
        }
        case "CodeBlock":
          eachLine(ref.from, ref.to, (l, isFirst, isLast) =>
            lineDeco(l, `lm-codeblock lm-codeblock-indented${isFirst ? " lm-codeblock-begin" : ""}${isLast ? " lm-codeblock-end" : ""}`));
          return false;
        case "Table":
          eachLine(ref.from, ref.to, (l) => lineDeco(l, "lm-table-source"));
          return false;
        case "HTMLBlock":
          eachLine(ref.from, ref.to, (l) => lineDeco(l, "lm-html-source"));
          return false;
      }
      return;
    },
  });

  return Decoration.set(out, true);
}

function decorateListMark(
  view: EditorView,
  listMark: SyntaxNode,
  live: boolean,
  out: Range<Decoration>[],
  mark: (cls: string, from: number, to: number) => void,
  lineDeco: (line: Line, cls: string, attributes?: Record<string, string>) => void,
): void {
  const { state } = view;
  const item = listMark.parent;
  const list = item?.parent;
  if (!item || !list) return;
  const line = state.doc.lineAt(listMark.from);
  const ordered = list.name === "OrderedList";
  const depth = countAncestors(item, "ListItem");
  const task = item.getChild("Task");
  const taskMarker = task?.getChild("TaskMarker");
  let prefixWidth: number;
  const spaceAfter = (pos: number) => (/[ \t]/.test(state.doc.sliceString(pos, pos + 1)) ? textWidth(view, " ") : 0);

  if (task && taskMarker && state.doc.lineAt(taskMarker.from).number === line.number) {
    const status = state.doc.sliceString(taskMarker.from + 1, taskMarker.to - 1);
    const done = status !== " ";
    lineDeco(line, `lm-list-line lm-task-line${done ? " lm-task-done" : ""}`, { "data-task": status });
    if (done) mark("lm-task-done-text", taskMarker.to, task.to);
    if (live && !touches(state, listMark.from, taskMarker.to)) {
      out.push(Decoration.replace({ widget: new CheckboxWidget(status) }).range(listMark.from, taskMarker.to));
      const fontPx = parseFloat(getComputedStyle(view.contentDOM).fontSize) || 16;
      prefixWidth = textWidth(view, state.doc.sliceString(line.from, listMark.from)) + 1.6 * fontPx + spaceAfter(taskMarker.to);
    } else {
      prefixWidth = textWidth(view, state.doc.sliceString(line.from, taskMarker.to)) + spaceAfter(taskMarker.to);
    }
  } else {
    lineDeco(line, `lm-list-line lm-list-depth-${Math.min(depth, 6)}`);
    if (ordered) mark("lm-list-number", listMark.from, listMark.to);
    else if (live && !touches(state, listMark.from, listMark.to)) mark("lm-list-bullet", listMark.from, listMark.to);
    else mark("lm-list-marker", listMark.from, listMark.to);
    prefixWidth = textWidth(view, state.doc.sliceString(line.from, listMark.to)) + spaceAfter(listMark.to);
  }
  // Hanging indent: wrapped lines line up with the text, not the bullet.
  out.push(Decoration.line({ attributes: { style: `--lm-hang: ${prefixWidth.toFixed(1)}px` } }).range(line.from));
}

function countAncestors(node: SyntaxNode, name: string): number {
  let n = 0;
  for (let p: SyntaxNode | null = node; p; p = p.parent) if (p.name === name) n++;
  return n;
}

function wholeLines(state: EditorState, from: number, to: number): boolean {
  return state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to;
}

const inlinePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildInline(view); }
  update(u: ViewUpdate) {
    if (needsRebuild(u) || u.viewportChanged) this.decorations = buildInline(u.view);
  }
}, { decorations: (v) => v.decorations });

// ---- block widgets (must come from a state field) ---------------------------

function innerText(state: EditorState, node: SyntaxNode, markName: string): string {
  const marks = node.getChildren(markName);
  const from = marks[0]?.to ?? node.from;
  const to = marks.length > 1 ? marks[marks.length - 1].from : node.to;
  return state.doc.sliceString(from, Math.max(from, to));
}

function buildBlocks(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const title = state.facet(inlineTitle);
  if (title) out.push(Decoration.widget({ widget: new InlineTitleWidget(title), block: true, side: -1 }).range(0));
  if (!state.field(livePreviewField)) return Decoration.set(out, true);

  const fm = state.field(frontmatterField);
  // Properties stay rendered with the cursor parked at the very start of the
  // note (where it lands on open); clicking them reveals the YAML.
  if (fm && !touches(state, fm.from + 1, fm.to - 1)) {
    out.push(Decoration.replace({ widget: new PropertiesWidget(fm.body), block: true }).range(fm.from, fm.to));
  }

  syntaxTree(state).iterate({
    enter: (ref) => {
      switch (ref.name) {
        case "Document": case "BulletList": case "OrderedList": case "ListItem":
          return;
        case "Blockquote": {
          if (ref.node.parent?.name === "Blockquote") return false;
          const first = state.doc.lineAt(ref.from);
          const m = CALLOUT_RE.exec(state.doc.sliceString(ref.from, first.to));
          if (m && calloutFold(state, first, m[3], ref.to).folded) {
            out.push(Decoration.replace({}).range(first.to, ref.to));
            return false;
          }
          return;
        }
        case "Table":
        case "BlockMath":
        case "FencedCode": {
          if ((fm && ref.from < fm.to) || !wholeLines(state, ref.from, ref.to)) return false;
          if (ref.name === "Table") {
            // Always rendered: cells are edited in place (see tableEditor.ts).
            const model = parseTable(state.doc, ref.from, ref.to);
            if (model) out.push(Decoration.replace({ widget: new TableWidget(model), block: true }).range(ref.from, ref.to));
            return false;
          }
          const isTouched = touches(state, ref.from, ref.to);
          let widget: MathWidget | MermaidWidget;
          if (ref.name === "BlockMath") {
            widget = new MathWidget(innerText(state, ref.node, "BlockMathMark"), true, true, isTouched);
          } else {
            const info = ref.node.getChild("CodeInfo");
            if (!info || state.doc.sliceString(info.from, info.to).trim().toLowerCase() !== "mermaid") return false;
            const firstLine = state.doc.lineAt(ref.from);
            const marks = ref.node.getChildren("CodeMark");
            const closing = marks.length >= 2 && marks[marks.length - 1].from > firstLine.to ? marks[marks.length - 1] : null;
            const code = state.doc.sliceString(Math.min(firstLine.to + 1, ref.to), closing ? Math.max(firstLine.to + 1, closing.from - 1) : ref.to);
            widget = new MermaidWidget(code, isTouched);
          }
          out.push(isTouched
            ? Decoration.widget({ widget, block: true, side: 1 }).range(ref.to)
            : Decoration.replace({ widget, block: true }).range(ref.from, ref.to));
          return false;
        }
        default:
          return false;
      }
    },
  });
  return Decoration.set(out, true);
}

const blockField = StateField.define<DecorationSet>({
  create: (state) => buildBlocks(state),
  update: (deco, tr) => (needsRebuild({ docChanged: tr.docChanged, startState: tr.startState, state: tr.state, transactions: [tr] })
    || tr.startState.facet(inlineTitle) !== tr.state.facet(inlineTitle) ? buildBlocks(tr.state) : deco.map(tr.changes)),
  provide: (f) => EditorView.decorations.from(f),
});

// ---- link clicks ---------------------------------------------------------------

const linkClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false;
    const link = (e.target as HTMLElement).closest<HTMLElement>("[data-href], [data-wiki], a[href]");
    if (!link || !view.contentDOM.contains(link)) return false;
    const modifier = e.ctrlKey || e.metaKey;
    if (!modifier) {
      // Plain clicks follow rendered links (as in Obsidian) but edit revealed ones.
      if (!view.state.field(livePreviewField)) return false;
      const pos = view.posAtDOM(link);
      if (touches(view.state, pos, pos + (link.textContent?.length ?? 0))) return false;
    }
    e.preventDefault();
    followLink(link, modifier);
    return true;
  },
});

const editorClasses = EditorView.editorAttributes.compute([livePreviewField], (state) => ({
  class: state.field(livePreviewField) ? "lm-live-preview" : "lm-source-mode",
}));

export function livePreview(): Extension {
  return [livePreviewField, frontmatterField, calloutFolds, inlinePlugin, blockField, linkClicks, editorClasses, tableEditing()];
}
