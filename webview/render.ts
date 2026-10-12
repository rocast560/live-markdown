// Renderers for content that gets drawn as a widget: math (MathJax, as in
// Obsidian), mermaid diagrams, and markdown snippets (table cells, embeds).
import MarkdownIt from "markdown-it";

const appData = () => (document.getElementById("app")?.dataset ?? {}) as DOMStringMap;

function loadScript(src: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!src) return reject(new Error("script URI missing"));
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// ---- MathJax ----------------------------------------------------------------

interface MathJaxApi {
  tex2svg(tex: string, opts: { display: boolean }): HTMLElement;
  startup: { defaultReady(): void };
}
const win = window as unknown as { MathJax?: MathJaxApi | object; mermaid?: MermaidApi };

let mathLoad: Promise<void> | null = null;
let mathLoaded = false;
const mathCache = new Map<string, HTMLElement>();

export function loadMathJax(): Promise<void> {
  if (!mathLoad) {
    mathLoad = new Promise<void>((resolve, reject) => {
      win.MathJax = {
        svg: { fontCache: "local" },
        // The hidden MathML copy for screen readers would otherwise be drawn
        // by Chromium's native MathML support, doubling every formula.
        options: { enableAssistiveMml: false, menuOptions: { settings: { assistiveMml: false } } },
        startup: {
          typeset: false,
          ready() {
            const mj = win.MathJax as MathJaxApi & { svgStylesheet?: () => HTMLElement };
            mj.startup.defaultReady();
            if (mj.svgStylesheet) document.head.appendChild(mj.svgStylesheet());
            mathLoaded = true;
            resolve();
          },
        },
      };
      loadScript(appData().mathjax).catch(reject);
    });
  }
  return mathLoad;
}

function mathNode(tex: string, display: boolean): HTMLElement {
  const key = (display ? "D:" : "I:") + tex;
  let node = mathCache.get(key);
  if (!node) {
    try {
      node = (win.MathJax as MathJaxApi).tex2svg(tex, { display });
    } catch (e) {
      node = document.createElement("span");
      node.className = "lm-error";
      node.textContent = String((e as Error).message ?? e);
    }
    if (mathCache.size > 500) mathCache.clear();
    mathCache.set(key, node);
  }
  return node.cloneNode(true) as HTMLElement;
}

/** Fill `into` with rendered TeX. Renders synchronously once MathJax is loaded. */
export function renderMath(tex: string, display: boolean, into: HTMLElement, onAsyncDone?: () => void): void {
  if (mathLoaded) {
    into.replaceChildren(mathNode(tex, display));
    return;
  }
  into.textContent = tex;
  into.classList.add("lm-pending");
  loadMathJax().then(() => {
    into.classList.remove("lm-pending");
    into.replaceChildren(mathNode(tex, display));
    onAsyncDone?.();
  }, (e) => {
    into.classList.add("lm-error");
    into.title = String(e);
  });
}

// ---- Mermaid ----------------------------------------------------------------

interface MermaidApi {
  initialize(cfg: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string }>;
}

let mermaidLoad: Promise<MermaidApi> | null = null;
let mermaidTheme = "";
let mermaidSeq = 0;

function isDark(): boolean {
  return document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
}

const mermaidCache = new Map<string, string>();

export async function renderMermaid(code: string, into: HTMLElement, onDone?: () => void): Promise<void> {
  const cacheKey = (isDark() ? "dark:" : "light:") + code;
  const cached = mermaidCache.get(cacheKey);
  if (cached) {
    into.innerHTML = cached;
    return;
  }
  into.classList.add("lm-pending");
  try {
    if (!mermaidLoad) mermaidLoad = loadScript(appData().mermaid).then(() => win.mermaid!);
    const mermaid = await mermaidLoad;
    const theme = isDark() ? "dark" : "default";
    if (theme !== mermaidTheme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "var(--font-text)" });
      mermaidTheme = theme;
    }
    const id = `lm-mermaid-${++mermaidSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      if (mermaidCache.size > 100) mermaidCache.clear();
      mermaidCache.set(cacheKey, svg);
      into.innerHTML = svg;
    } catch (e) {
      document.getElementById("d" + id)?.remove();
      document.getElementById(id)?.remove();
      into.textContent = `Mermaid: ${(e as Error).message ?? e}`;
      into.classList.add("lm-error");
    }
  } catch (e) {
    into.textContent = `Could not load mermaid: ${e}`;
    into.classList.add("lm-error");
  }
  into.classList.remove("lm-pending");
  onDone?.();
}

// ---- Markdown snippets --------------------------------------------------------

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

function obsidianInline(html: string): string {
  return html
    .replace(/!?\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
      (_m, target: string, alias?: string) => `<a class="lm-internal-link" data-wiki="${target.replace(/"/g, "&quot;")}">${alias ?? target}</a>`)
    .replace(/==([^=\n]+?)==/g, '<mark class="lm-highlight">$1</mark>')
    .replace(/(^|[\s>])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu, '$1<span class="lm-tag">#$2</span>');
}

export function renderInlineMarkdown(src: string): string {
  return obsidianInline(md.renderInline(src));
}

export function renderMarkdown(src: string): string {
  return obsidianInline(md.render(src));
}

/** Render $…$ math left in markdown-rendered HTML (table cells, embeds). */
export function renderMathIn(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\$[^$\s][^$]*\$/.test(n.nodeValue ?? "")) hits.push(n as Text);
  for (const textNode of hits) {
    const frag = document.createDocumentFragment();
    const parts = (textNode.nodeValue ?? "").split(/(\$\$[^$]+\$\$|\$[^$\s](?:[^$]*[^$\s])?\$)/);
    for (const part of parts) {
      const m = /^\$\$([^$]+)\$\$$|^\$([^$]+)\$$/.exec(part);
      if (!m) { frag.append(part); continue; }
      const span = document.createElement("span");
      span.className = "lm-math";
      renderMath(m[1] ?? m[2], m[1] !== undefined, span);
      frag.append(span);
    }
    textNode.replaceWith(frag);
  }
}
