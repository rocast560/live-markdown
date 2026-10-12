// Lezer markdown extensions for Obsidian-flavoured syntax that CommonMark/GFM
// don't cover: ==highlights==, [[wikilinks]], ![[embeds]], #tags, $math$,
// $$block math$$, %%comments%% and [^footnote] references.
import type { MarkdownConfig, Element } from "@lezer/markdown";
import { tags, Tag } from "@lezer/highlight";

export const lpTags = {
  highlight: Tag.define(),
  wikilink: Tag.define(),
  tag: Tag.define(),
  math: Tag.define(),
  comment: Tag.define(),
};

const Punct = /[\p{S}\p{P}]/u;
const isSpace = (c: number) => c == 32 || c == 9 || c == 10 || c == 13 || c < 0;

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": lpTags.highlight } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [{
    name: "Highlight",
    parse(cx, next, pos) {
      if (next != 61 || cx.char(pos + 1) != 61 || cx.char(pos + 2) == 61 || cx.char(pos - 1) == 61) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
      const pBefore = Punct.test(before), pAfter = Punct.test(after);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2,
        !sAfter && (!pAfter || sBefore || pBefore),
        !sBefore && (!pBefore || sAfter || pAfter));
    },
    after: "Emphasis",
  }],
};

const WikiLinks: MarkdownConfig = {
  defineNodes: [
    { name: "WikiLink", style: lpTags.wikilink },
    { name: "Embed", style: lpTags.wikilink },
    { name: "WikiLinkMark", style: tags.processingInstruction },
    { name: "WikiLinkTarget" },
    { name: "WikiLinkAlias" },
  ],
  parseInline: [{
    name: "WikiLink",
    parse(cx, next, pos) {
      const start = pos;
      let embed = false;
      if (next == 33 /* ! */) {
        if (cx.char(pos + 1) != 91 || cx.char(pos + 2) != 91) return -1;
        embed = true;
        pos++;
      } else if (next != 91 || cx.char(pos + 1) != 91) {
        return -1;
      }
      const open = pos + 2;
      let close = -1;
      for (let i = open; i < cx.end - 1; i++) {
        const c = cx.char(i);
        if (c == 10) return -1;
        if (c == 91 && cx.char(i + 1) == 91) return -1;
        if (c == 93 && cx.char(i + 1) == 93) { close = i; break; }
      }
      if (close <= open) return -1;
      const inner = cx.slice(open, close);
      const pipe = inner.indexOf("|");
      const children: Element[] = [cx.elt("WikiLinkMark", start, open)];
      if (pipe >= 0) {
        if (pipe > 0) children.push(cx.elt("WikiLinkTarget", open, open + pipe));
        children.push(cx.elt("WikiLinkMark", open + pipe, open + pipe + 1));
        if (pipe + 1 < inner.length) children.push(cx.elt("WikiLinkAlias", open + pipe + 1, close));
      } else {
        children.push(cx.elt("WikiLinkTarget", open, close));
      }
      children.push(cx.elt("WikiLinkMark", close, close + 2));
      return cx.addElement(cx.elt(embed ? "Embed" : "WikiLink", start, close + 2, children));
    },
    before: "Link",
  }],
};

const FootnoteRefs: MarkdownConfig = {
  defineNodes: [{ name: "FootnoteRef" }, { name: "FootnoteMark", style: tags.processingInstruction }],
  parseInline: [{
    name: "FootnoteRef",
    parse(cx, next, pos) {
      if (next != 91 || cx.char(pos + 1) != 94) return -1;
      const m = /^\[\^([^\]\s]+)\]/.exec(cx.slice(pos, Math.min(cx.end, pos + 120)));
      if (!m) return -1;
      const end = pos + m[0].length;
      if (cx.char(end) == 58 /* : */) return -1;
      return cx.addElement(cx.elt("FootnoteRef", pos, end, [
        cx.elt("FootnoteMark", pos, pos + 2), cx.elt("FootnoteMark", end - 1, end),
      ]));
    },
    before: "Link",
  }],
};

const Tags: MarkdownConfig = {
  defineNodes: [{ name: "Tag", style: lpTags.tag }],
  parseInline: [{
    name: "Tag",
    parse(cx, next, pos) {
      if (next != 35 /* # */) return -1;
      if (pos > cx.offset && !isSpace(cx.char(pos - 1))) return -1;
      const m = /^#([\p{L}\p{N}_\-/]+)/u.exec(cx.slice(pos, Math.min(cx.end, pos + 200)));
      if (!m || /^[\d/\-_]+$/.test(m[1])) return -1;
      return cx.addElement(cx.elt("Tag", pos, pos + m[0].length));
    },
  }],
};

const InlineMath: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: lpTags.math },
    { name: "InlineMathMark", style: tags.processingInstruction },
  ],
  parseInline: [{
    name: "InlineMath",
    parse(cx, next, pos) {
      if (next != 36 /* $ */) return -1;
      const display = cx.char(pos + 1) == 36;
      const open = pos + (display ? 2 : 1);
      if (!display && isSpace(cx.char(open))) return -1;
      for (let i = open; i < cx.end; i++) {
        const c = cx.char(i);
        if (c == 10) return -1;
        if (c == 92 /* \ */) { i++; continue; }
        if (c != 36) continue;
        if (display) {
          if (cx.char(i + 1) != 36 || i == open) return -1;
          return cx.addElement(cx.elt("InlineMath", pos, i + 2, [
            cx.elt("InlineMathMark", pos, open), cx.elt("InlineMathMark", i, i + 2),
          ]));
        }
        if (isSpace(cx.char(i - 1)) || i == open) return -1;
        const after = cx.char(i + 1);
        if (after >= 48 && after <= 57) return -1;
        return cx.addElement(cx.elt("InlineMath", pos, i + 1, [
          cx.elt("InlineMathMark", pos, open), cx.elt("InlineMathMark", i, i + 1),
        ]));
      }
      return -1;
    },
  }],
};

const Comments: MarkdownConfig = {
  defineNodes: [{ name: "Comment", style: lpTags.comment }, { name: "CommentMark", style: tags.processingInstruction }],
  parseInline: [{
    name: "Comment",
    parse(cx, next, pos) {
      if (next != 37 || cx.char(pos + 1) != 37) return -1;
      const idx = cx.slice(pos + 2, cx.end).indexOf("%%");
      if (idx < 0) return -1;
      const end = pos + 2 + idx + 2;
      return cx.addElement(cx.elt("Comment", pos, end, [
        cx.elt("CommentMark", pos, pos + 2), cx.elt("CommentMark", end - 2, end),
      ]));
    },
    before: "Emphasis",
  }],
};

const startsBlockMath = (text: string, pos: number) => text.charCodeAt(pos) == 36 && text.charCodeAt(pos + 1) == 36;

const BlockMath: MarkdownConfig = {
  defineNodes: [
    { name: "BlockMath", block: true, style: lpTags.math },
    { name: "BlockMathMark", style: tags.processingInstruction },
  ],
  parseBlock: [{
    name: "BlockMath",
    parse(cx, line) {
      if (!startsBlockMath(line.text, line.pos)) return false;
      const from = cx.lineStart + line.pos;
      const children: Element[] = [cx.elt("BlockMathMark", from, from + 2)];
      const sameLineClose = line.text.indexOf("$$", line.pos + 2);
      if (sameLineClose >= 0) {
        const cf = cx.lineStart + sameLineClose;
        children.push(cx.elt("BlockMathMark", cf, cf + 2));
        const end = cx.lineStart + line.text.length;
        cx.nextLine();
        cx.addElement(cx.elt("BlockMath", from, end, children));
        return true;
      }
      let end = cx.lineStart + line.text.length;
      // `line.depth` isn't in the public typings but is what FencedCode uses to
      // stop at the end of an enclosing blockquote/list.
      while (cx.nextLine() && (line as unknown as { depth: number }).depth >= cx.depth) {
        children.push(...line.markers);
        end = cx.lineStart + line.text.length;
        const close = line.text.indexOf("$$", line.pos);
        if (close >= 0) {
          children.push(cx.elt("BlockMathMark", cx.lineStart + close, cx.lineStart + close + 2));
          cx.nextLine();
          break;
        }
      }
      cx.addElement(cx.elt("BlockMath", from, end, children));
      return true;
    },
    endLeaf: (_cx, line) => startsBlockMath(line.text, line.pos),
  }],
};

export const obsidianSyntax: MarkdownConfig[] = [
  Highlight, WikiLinks, FootnoteRefs, Tags, InlineMath, Comments, BlockMath,
];

/** Range of a YAML frontmatter block at the very top of the document, if any. */
export function findFrontmatter(text: string): { from: number; to: number; body: string } | null {
  const m = /^---[ \t]*\n([\s\S]*?\n)?(---|\.\.\.)[ \t]*(?=\n|$)/.exec(text.slice(0, 100_000));
  if (!m) return null;
  return { from: 0, to: m[0].length, body: m[1] ?? "" };
}
