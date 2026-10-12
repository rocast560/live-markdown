// Widgets that stand in for markdown source while it isn't being edited.
import { EditorView, WidgetType } from "@codemirror/view";
import { icon } from "./icons";
import { renderMath, renderMermaid, renderInlineMarkdown, renderMarkdown, renderMathIn } from "./render";
import { post, resolveEmbed, resolveImageSrc, request, settledEmbeds } from "./host";
import type { EmbedInfo } from "../src/protocol";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Move the cursor to `pos` (revealing the source there) and focus the editor. */
export function revealAt(view: EditorView, pos: number): void {
  view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: false });
  view.focus();
}

/** Follow a rendered link element ([data-href], [data-wiki] or a plain <a href>). */
export function followLink(link: HTMLElement, newTab: boolean): void {
  const wiki = link.dataset.wiki;
  if (wiki !== undefined) {
    post({ type: "openWikiLink", target: wiki, newTab });
    return;
  }
  const href = link.dataset.href ?? link.getAttribute("href");
  if (href) post({ type: "openLink", href, newTab });
}

/** Parse Obsidian's `|300` / `|300x200` size suffix. */
export function parseSize(spec: string): { width?: number; height?: number } | null {
  const m = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(spec);
  return m ? { width: Number(m[1]), height: m[2] ? Number(m[2]) : undefined } : null;
}

export class InlineTitleWidget extends WidgetType {
  constructor(readonly title: string) { super(); }
  eq(other: InlineTitleWidget) { return other.title === this.title; }
  toDOM() { return el("div", "lm-inline-title", this.title); }
  ignoreEvent() { return true; }
}

export class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() { return el("span", "lm-hr"); }
  ignoreEvent() { return false; }
}

export class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly cls: string) { super(); }
  eq(other: TextWidget) { return other.text === this.text && other.cls === this.cls; }
  toDOM() { return el("span", this.cls, this.text); }
  ignoreEvent() { return false; }
}

export class ExternalLinkIconWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const span = el("span", "lm-external-icon");
    span.append(icon("external-link"));
    return span;
  }
  ignoreEvent() { return false; }
}

export function toggleTaskAt(view: EditorView, pos: number): void {
  const line = view.state.doc.lineAt(pos);
  const rel = pos - line.from;
  const m = /^(?:[-*+]|\d+[.)])[ \t]+\[(.)\]/.exec(line.text.slice(rel));
  if (!m) return;
  const at = pos + m[0].length - 2;
  view.dispatch({
    changes: { from: at, to: at + 1, insert: m[1] === " " ? "x" : " " },
    userEvent: "input.toggleTask",
  });
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly status: string) { super(); }
  eq(other: CheckboxWidget) { return other.status === this.status; }
  toDOM(view: EditorView) {
    const wrap = el("span", "lm-task-checkbox-wrap");
    const box = el("input", "lm-task-checkbox");
    box.type = "checkbox";
    box.checked = this.status !== " ";
    if (this.status !== " " && this.status.toLowerCase() !== "x") box.dataset.task = this.status;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTaskAt(view, view.posAtDOM(wrap));
    });
    wrap.append(box);
    return wrap;
  }
  ignoreEvent() { return true; }
}

export class CalloutTitleWidget extends WidgetType {
  constructor(readonly iconName: string, readonly defaultTitle: string) { super(); }
  eq(other: CalloutTitleWidget) { return other.iconName === this.iconName && other.defaultTitle === this.defaultTitle; }
  toDOM() {
    const span = el("span", "lm-callout-head");
    const ic = el("span", "lm-callout-icon");
    ic.append(icon(this.iconName));
    span.append(ic);
    if (this.defaultTitle) span.append(el("span", "lm-callout-title-text", this.defaultTitle));
    return span;
  }
  ignoreEvent() { return false; }
}

export class CodeHeaderWidget extends WidgetType {
  constructor(readonly lang: string, readonly code: string) { super(); }
  eq(other: CodeHeaderWidget) { return other.lang === this.lang && other.code === this.code; }
  toDOM() {
    const span = el("span", "lm-code-header");
    if (this.lang) span.append(el("span", "lm-code-lang", this.lang));
    const btn = el("button", "lm-code-copy");
    btn.title = "Copy";
    btn.append(icon("copy"));
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      post({ type: "copyText", text: this.code });
      btn.classList.add("lm-copied");
      setTimeout(() => btn.classList.remove("lm-copied"), 1200);
    });
    span.append(btn);
    return span;
  }
  ignoreEvent(e: Event) { return (e.target as HTMLElement).closest?.(".lm-code-copy") != null; }
}

export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly block = false, readonly preview = false) { super(); }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display && other.block === this.block && other.preview === this.preview;
  }
  toDOM(view: EditorView) {
    const e = el(this.block ? "div" : "span", this.block ? `lm-math-block${this.preview ? " lm-preview" : ""}` : "lm-math");
    renderMath(this.tex.trim(), this.display, e, () => view.requestMeasure());
    return e;
  }
  get estimatedHeight() { return this.block ? 60 : -1; }
  ignoreEvent() { return false; }
}

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string, readonly preview = false) { super(); }
  eq(other: MermaidWidget) { return other.code === this.code && other.preview === this.preview; }
  toDOM(view: EditorView) {
    const e = el("div", `lm-mermaid${this.preview ? " lm-preview" : ""}`);
    void renderMermaid(this.code, e, () => view.requestMeasure());
    return e;
  }
  get estimatedHeight() { return 200; }
  ignoreEvent() { return false; }
}

function brokenImage(name: string): HTMLElement {
  const box = el("span", "lm-embed-missing");
  box.append(icon("image-off"), el("span", "", ` Unable to find “${name}”`));
  return box;
}

export class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly width?: number, readonly height?: number) { super(); }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt && other.width === this.width && other.height === this.height;
  }
  toDOM(view: EditorView) {
    const wrap = el("span", "lm-image-embed");
    const img = el("img");
    img.alt = this.alt;
    if (this.width) img.style.width = `${this.width}px`;
    if (this.height) img.style.height = `${this.height}px`;
    let retried = false;
    img.addEventListener("load", () => view.requestMeasure());
    img.addEventListener("error", () => {
      // Relative paths that don't resolve next to the note: look the file up by
      // name anywhere in the workspace, like Obsidian does.
      if (retried || /^(https?:|data:)/i.test(this.src)) {
        wrap.replaceChildren(brokenImage(this.src));
        return;
      }
      retried = true;
      request<string | null>({ type: "resolveImage", src: this.src }).then((uri) => {
        if (uri) img.src = uri;
        else wrap.replaceChildren(brokenImage(this.src));
      });
    });
    img.src = resolveImageSrc(this.src);
    wrap.append(img);
    return wrap;
  }
  ignoreEvent() { return false; }
}

function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const want = heading.trim().toLowerCase();
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start < 0) {
      if (m[2].toLowerCase() === want) { start = i; level = m[1].length; }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join("\n");
    }
  }
  return start < 0 ? markdown : lines.slice(start).join("\n");
}

export class EmbedWidget extends WidgetType {
  constructor(readonly target: string, readonly modifier: string) { super(); }
  eq(other: EmbedWidget) { return other.target === this.target && other.modifier === this.modifier; }

  toDOM(view: EditorView) {
    const wrap = el("span", "lm-embed");
    const file = this.target.split("#")[0];
    const settled = settledEmbeds.get(file);
    if (settled) {
      this.fill(wrap, settled, view);
    } else {
      wrap.classList.add("lm-pending");
      resolveEmbed(file).then((info) => {
        wrap.classList.remove("lm-pending");
        this.fill(wrap, info, view);
        view.requestMeasure();
      });
    }
    return wrap;
  }

  private fill(wrap: HTMLElement, info: EmbedInfo, view: EditorView) {
    const size = parseSize(this.modifier);
    wrap.replaceChildren();
    switch (info.kind) {
      case "image": {
        const img = el("img");
        img.src = info.uri;
        img.alt = this.modifier && !size ? this.modifier : info.name;
        if (size?.width) img.style.width = `${size.width}px`;
        if (size?.height) img.style.height = `${size.height}px`;
        img.addEventListener("load", () => view.requestMeasure());
        wrap.className = "lm-image-embed";
        wrap.append(img);
        break;
      }
      case "audio":
      case "video": {
        const media = el(info.kind);
        media.src = info.uri;
        media.controls = true;
        wrap.className = `lm-media-embed lm-${info.kind}-embed`;
        wrap.append(media);
        break;
      }
      case "note": {
        wrap.className = "lm-embed lm-note-embed";
        const head = el("span", "lm-embed-title");
        const link = el("a", "lm-internal-link", info.name);
        link.dataset.wiki = this.target;
        head.append(icon("file-text"), link);
        const body = el("div", "lm-embed-content markdown-rendered");
        const section = this.target.includes("#") ? extractSection(info.markdown, this.target.split("#")[1]) : info.markdown;
        body.innerHTML = renderMarkdown(section.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)\s*\n/, ""));
        renderMathIn(body);
        wrap.append(head, body);
        wrap.addEventListener("mousedown", (e) => {
          const a = (e.target as HTMLElement).closest<HTMLElement>("a[href], [data-wiki]");
          if (!a) return;
          e.preventDefault();
          e.stopPropagation();
          followLink(a, e.ctrlKey || e.metaKey);
        });
        break;
      }
      case "pdf":
      case "file": {
        wrap.className = "lm-embed lm-file-embed";
        const link = el("a", "lm-internal-link", info.name);
        link.dataset.wiki = this.target;
        wrap.append(icon("file-text"), link);
        break;
      }
      case "missing":
        wrap.className = "lm-embed";
        wrap.append(brokenImage(info.name));
        break;
    }
  }

  ignoreEvent(e: Event) {
    return e.type === "mousedown" && (e.target as HTMLElement).closest?.("a, [data-wiki], audio, video") != null;
  }
}

/** Minimal YAML reader for frontmatter: scalars, inline [lists] and "- item" lists. */
export function parseProperties(yaml: string): { key: string; value: string | string[] }[] {
  const props: { key: string; value: string | string[] }[] = [];
  let current: { key: string; value: string | string[] } | null = null;
  const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
  for (const line of yaml.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && current) {
      current.value = Array.isArray(current.value) ? [...current.value, unquote(item[1])] : [unquote(item[1])];
      continue;
    }
    const kv = /^([^:#][^:]*):\s*(.*)$/.exec(line);
    if (kv) {
      const raw = kv[2].trim();
      const value = /^\[.*\]$/.test(raw)
        ? raw.slice(1, -1).split(",").map(unquote).filter(Boolean)
        : unquote(raw);
      current = { key: kv[1].trim(), value };
      props.push(current);
    } else if (current && typeof current.value === "string") {
      current.value = `${current.value} ${line.trim()}`.trim();
    }
  }
  return props;
}

const PROPERTY_ICONS: Record<string, string> = { tags: "tag", tag: "tag", aliases: "list", alias: "list", cssclasses: "list" };

export class PropertiesWidget extends WidgetType {
  constructor(readonly yaml: string) { super(); }
  eq(other: PropertiesWidget) { return other.yaml === this.yaml; }
  toDOM(view: EditorView) {
    const box = el("div", "lm-properties");
    box.append(el("div", "lm-properties-heading", "Properties"));
    for (const { key, value } of parseProperties(this.yaml)) {
      const row = el("div", "lm-property");
      const k = el("div", "lm-property-key");
      const iconName = PROPERTY_ICONS[key.toLowerCase()]
        ?? (Array.isArray(value) ? "list"
          : /^(true|false)$/i.test(String(value)) ? "square-check"
            : /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? "calendar" : "text");
      k.append(icon(iconName), el("span", "", key));
      const v = el("div", "lm-property-value");
      if (Array.isArray(value)) {
        for (const item of value) {
          const isTag = /^tags?$/i.test(key);
          const pill = el("span", isTag ? "lm-tag" : "lm-property-pill");
          pill.innerHTML = isTag ? `#${item.replace(/^#/, "").replace(/</g, "&lt;")}` : renderInlineMarkdown(item);
          v.append(pill);
        }
      } else if (/^(true|false)$/i.test(value)) {
        const cb = el("input", "lm-task-checkbox");
        cb.type = "checkbox";
        cb.checked = value.toLowerCase() === "true";
        cb.disabled = true;
        v.append(cb);
      } else {
        v.innerHTML = renderInlineMarkdown(value) || '<span class="lm-faint">Empty</span>';
      }
      row.append(k, v);
      box.append(row);
    }
    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const link = (e.target as HTMLElement).closest<HTMLElement>("a[href], [data-wiki]");
      if (link) followLink(link, e.ctrlKey || e.metaKey);
      else revealAt(view, view.posAtDOM(box) + 4);
    });
    return box;
  }
  get estimatedHeight() { return 40 + 30 * parseProperties(this.yaml).length; }
  ignoreEvent() { return true; }
}
