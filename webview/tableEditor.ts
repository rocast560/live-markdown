// Obsidian-style table editing. In Live Preview a table stays rendered and each
// cell is edited in place: clicking a cell swaps it for a small nested editor
// whose changes are written straight into that cell's markdown. Tab / Enter /
// arrow keys move between cells, and a right-click menu (plus the "+" bars on the
// edges) adds, removes and aligns rows and columns.
import { Annotation, EditorState, Facet, Prec, StateEffect, StateField, Transaction, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from "@codemirror/view";
import { renderInlineMarkdown, renderMathIn } from "./render";
import { followLink } from "./widgets";

export type Align = "left" | "center" | "right" | null;
/** A cell's trimmed source (`from`–`to`) and the space between its pipes (`slotFrom`–`slotTo`). */
export interface TableCell { text: string; from: number; to: number; slotFrom: number; slotTo: number }
export interface TableRow { from: number; to: number; cells: TableCell[] }
/** A table, with absolute document positions. `rows[0]` is the header; the delimiter row is left out. */
export interface TableModel { from: number; to: number; aligns: Align[]; rows: TableRow[]; cols: number }

/** Extensions for the nested cell editors (markdown, live preview, …), supplied by main.ts. */
export const tableCellSetup = Facet.define<Extension, Extension>({ combine: (v) => v });

// ---- parsing & writing tables ---------------------------------------------------------

/** Split a table row the way the GFM parser does: on every pipe that isn't backslash-escaped. */
export function splitRow(text: string): TableCell[] {
  const pipes: number[] = [];
  for (let i = 0, esc = false; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 124 && !esc) pipes.push(i);
    esc = !esc && ch === 92;
  }
  const slots: [number, number][] = [];
  let start = 0;
  for (const p of pipes) { slots.push([start, p]); start = p + 1; }
  slots.push([start, text.length]);
  const lead = text.search(/\S/), trail = text.trimEnd().length;
  if (pipes.length && pipes[0] === lead) slots.shift();
  if (pipes.length && pipes[pipes.length - 1] === trail - 1 && slots.length) slots.pop();
  return slots.map(([s, e]) => {
    const raw = text.slice(s, e);
    const trimmed = raw.trim();
    if (!trimmed) {
      // Empty cell: type after one space, so "|  |" becomes "| x |".
      const at = s + Math.min(1, raw.length);
      return { text: "", from: at, to: at, slotFrom: s, slotTo: e };
    }
    const from = s + raw.length - raw.trimStart().length;
    return { text: trimmed, from, to: from + trimmed.length, slotFrom: s, slotTo: e };
  });
}

export function parseTable(doc: Text, from: number, to: number): TableModel | null {
  const rows: TableRow[] = [];
  let aligns: Align[] | null = null;
  const first = doc.lineAt(from).number, last = doc.lineAt(to).number;
  for (let n = first; n <= last; n++) {
    const line = doc.line(n);
    const cells = splitRow(line.text).map((c) => ({
      ...c, from: line.from + c.from, to: line.from + c.to, slotFrom: line.from + c.slotFrom, slotTo: line.from + c.slotTo,
    }));
    if (n === first + 1) {
      if (!cells.length || !cells.every((c) => /^:?-+:?$/.test(c.text))) return null;
      aligns = cells.map((c) => {
        const l = c.text.startsWith(":"), r = c.text.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      continue;
    }
    rows.push({ from: line.from, to: line.to, cells });
  }
  if (!aligns || !rows.length) return null;
  const cols = Math.max(aligns.length, ...rows.map((r) => r.cells.length));
  return { from, to, aligns, rows, cols };
}

const formatRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
const DELIMITERS: Record<string, string> = { left: ":--", center: ":-:", right: "--:" };

function serialize(grid: string[][], aligns: Align[]): string {
  const cols = Math.max(1, aligns.length, ...grid.map((r) => r.length));
  const pad = (cells: string[]) => Array.from({ length: cols }, (_, i) => cells[i] ?? "");
  const delimiter = formatRow(pad([]).map((_, i) => DELIMITERS[aligns[i] ?? ""] ?? "---"));
  return [formatRow(pad(grid[0])), delimiter, ...grid.slice(1).map((r) => formatRow(pad(r)))].join("\n");
}

/** Which cell holds the document range `from`–`to`, if it sits inside one cell. */
function locateCell(model: TableModel, from: number, to: number): { row: number; col: number } | null {
  for (let r = 0; r < model.rows.length; r++) {
    const row = model.rows[r];
    if (from < row.from || to > row.to) continue;
    const col = row.cells.findIndex((c) => c.slotFrom <= from && to <= c.slotTo);
    return col < 0 ? null : { row: r, col };
  }
  return null;
}

function renderCell(into: HTMLElement, text: string): void {
  // Obsidian allows <br> for line breaks inside a cell.
  into.innerHTML = renderInlineMarkdown(text).replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  renderMathIn(into);
}

// ---- which cell is being edited -----------------------------------------------------------

/** The document range of the cell being edited, kept in step with every change. */
const setActiveCell = StateEffect.define<{ from: number; to: number }>();
const activeCellField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    if (value && tr.docChanged) value = { from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) };
    for (const e of tr.effects) if (e.is(setActiveCell)) value = e.value;
    return value;
  },
});

/** Marks main-editor transactions made by the table editor itself. */
const fromTable = Annotation.define<boolean>();
/** Marks cell-editor transactions that only mirror the main document. */
const mirrored = Annotation.define<boolean>();

// ---- the editing controller behind each rendered table --------------------------------------

type Place = "start" | "end" | number | { x: number; y: number | "top" | "bottom" };

/** A cell is one line of markdown: typed or pasted pipes are escaped, line breaks become spaces. */
function escapePipes(text: string, escaped = false): string {
  let out = "";
  for (const ch of text) {
    if (ch === "|" && !escaped) out += "\\";
    out += ch;
    escaped = !escaped && ch === "\\";
  }
  return out;
}
const cellInput: Extension = [
  EditorView.inputHandler.of((view, from, to, text) => {
    if (!text.includes("|")) return false;
    const insert = escapePipes(text, view.state.sliceDoc(from - 1, from) === "\\");
    if (insert === text) return false;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.type" });
    return true;
  }),
  EditorView.clipboardInputFilter.of((text) => escapePipes(text.replace(/\r?\n/g, " "))),
  EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(mirrored)) return tr;
    let multiline = false;
    tr.changes.iterChanges((_a, _b, _c, _d, inserted) => { if (inserted.lines > 1) multiline = true; });
    if (!multiline) return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((from, to, _c, _d, inserted) => changes.push({ from, to, insert: inserted.toString().replace(/\n/g, " ") }));
    // Same lengths, so the transaction's selection still fits.
    return { changes, selection: tr.selection, effects: tr.effects, userEvent: tr.annotation(Transaction.userEvent), scrollIntoView: tr.scrollIntoView };
  }),
];

const controllers = new Set<TableController>();
const controllerOf = new WeakMap<HTMLElement, TableController>();

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

class TableController {
  readonly dom = el("div", "lm-table-wrap");
  private readonly table = el("table", "lm-table");
  private cellEls: HTMLTableCellElement[][] = [];
  private active: { row: number; col: number; editor: EditorView } | null = null;
  private pending: { row: number; col: number; place: Place } | null = null;
  private pushing = false;

  constructor(readonly view: EditorView, public model: TableModel) {
    const inner = el("div", "lm-table-inner");
    const addCol = el("button", "lm-table-add lm-table-add-col", "+");
    addCol.title = "Add column";
    const addRow = el("button", "lm-table-add lm-table-add-row", "+");
    addRow.title = "Add row";
    addCol.addEventListener("click", () => this.insertColumn(this.model.cols, 0));
    addRow.addEventListener("click", () => this.insertRow(this.model.rows.length, 0));
    inner.append(this.table, addCol, addRow);
    this.dom.append(inner);
    this.render();
    this.dom.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.dom.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    controllers.add(this);
    controllerOf.set(this.dom, this);
  }

  // -- rendering --

  private render(): void {
    const thead = el("thead"), tbody = el("tbody");
    this.cellEls = this.model.rows.map((row, r) => {
      const tr = el("tr");
      const cells: HTMLTableCellElement[] = [];
      for (let c = 0; c < this.model.cols; c++) {
        const cell = el(r === 0 ? "th" : "td");
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        const align = this.model.aligns[c];
        if (align) cell.style.textAlign = align;
        renderCell(cell, row.cells[c]?.text ?? "");
        tr.append(cell);
        cells.push(cell);
      }
      (r === 0 ? thead : tbody).append(tr);
      return cells;
    });
    this.table.replaceChildren(thead, tbody);
    const a = this.active;
    if (a) {
      const host = this.cellEls[a.row]?.[a.col];
      if (host) {
        const hadFocus = a.editor.hasFocus;
        host.replaceChildren(a.editor.dom);
        host.classList.add("lm-cell-active");
        if (hadFocus) a.editor.focus();
      } else {
        this.unmount();
      }
    }
  }

  /** Called (through TableWidget.updateDOM) whenever the table's markdown changed. */
  update(model: TableModel): void {
    const prev = this.model;
    this.model = model;
    const { state } = this.view;
    let lost: { row: number; col: number } | null = null;
    let moved = false;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      this.unmount(false);
    } else if (this.active) {
      const range = state.field(activeCellField);
      const at = range && locateCell(model, range.from, range.to);
      if (at) {
        moved = at.row !== this.active.row || at.col !== this.active.col;
        this.active.row = at.row;
        this.active.col = at.col;
      } else {
        // The edited cell no longer exists as such (e.g. undoing a column insert):
        // pick the editor back up at the same spot once this update is done.
        lost = { row: this.active.row, col: this.active.col };
        this.unmount(false);
      }
    }

    const reshaped = prev.rows.length !== model.rows.length || prev.cols !== model.cols || prev.aligns.join() !== model.aligns.join();
    if (reshaped || moved) {
      this.render();
    } else {
      model.rows.forEach((row, r) => {
        for (let c = 0; c < model.cols; c++) {
          if (this.active && this.active.row === r && this.active.col === c) continue;
          const text = row.cells[c]?.text ?? "";
          const host = this.cellEls[r][c];
          if (text !== (prev.rows[r].cells[c]?.text ?? "") || host.classList.contains("lm-cell-active")) {
            host.classList.remove("lm-cell-active");
            renderCell(host, text);
          }
        }
      });
    }

    // Changes that didn't come from the cell editor (undo, edits from outside VS Code
    // or the text editor) are mirrored into it.
    const a = this.active;
    const range = state.field(activeCellField);
    if (a && range && !this.pushing) {
      const text = state.doc.sliceString(range.from, range.to);
      const current = a.editor.state.doc.toString();
      if (text !== current) {
        const head = state.selection.main.head;
        const anchor = head >= range.from && head <= range.to ? head - range.from : Math.min(a.editor.state.selection.main.head, text.length);
        a.editor.dispatch({ changes: { from: 0, to: current.length, insert: text }, selection: { anchor }, annotations: mirrored.of(true) });
      }
    }
    if (pending) {
      const r = state.field(activeCellField);
      if (r) this.mount(pending.row, pending.col, pending.place, r);
    }
    // Undo/redo put the main cursor where the change happened: if that's another cell
    // (or the edited cell is gone), carry on editing there once this update is done.
    const head = state.selection.main.head;
    const follow = !pending && !this.pushing && head > model.from && head < model.to
      && (lost !== null || (a !== null && range !== null && (head < range.from || head > range.to)));
    if (follow || lost) {
      queueMicrotask(() => {
        if (!controllers.has(this)) return;
        if (follow) {
          this.activateAt(this.view.state.selection.main.head);
        } else if (lost && !this.active) {
          this.activate(Math.min(lost.row, this.model.rows.length - 1), Math.min(lost.col, this.model.cols - 1), "end");
        }
      });
    }
    this.view.requestMeasure();
  }

  destroy(): void {
    const hadFocus = this.active?.editor.hasFocus;
    this.unmount(false);
    controllers.delete(this);
    // Runs during an editor update, so hand focus back afterwards.
    if (hadFocus) queueMicrotask(() => { if (this.view.dom.isConnected) this.view.focus(); });
  }

  // -- the nested cell editor --

  /** Start editing a cell. Rows that are missing cells are filled out first. */
  activate(row: number, col: number, place: Place): void {
    const rowModel = this.model.rows[row];
    if (!rowModel || col < 0 || col >= this.model.cols) return;
    if (this.active && this.active.row === row && this.active.col === col) {
      this.placeCursor(this.active.editor, place);
      this.active.editor.focus();
      return;
    }
    const cell = rowModel.cells[col];
    if (!cell) {
      const texts = Array.from({ length: this.model.cols }, (_, i) => rowModel.cells[i]?.text ?? "");
      const line = formatRow(texts);
      const target = splitRow(line)[col];
      const from = rowModel.from + target.from, to = rowModel.from + target.to;
      this.pending = { row, col, place };
      this.view.dispatch({
        changes: { from: rowModel.from, to: rowModel.to, insert: line },
        selection: { anchor: from },
        effects: setActiveCell.of({ from, to }),
        annotations: fromTable.of(true),
        userEvent: "input.table",
      });
      return;
    }
    const range = { from: cell.from, to: cell.to };
    this.mount(row, col, place, range);
    // Keep the main selection inside the table so undo/redo scroll here, not elsewhere.
    this.view.dispatch({ selection: { anchor: cell.from }, effects: setActiveCell.of(range), annotations: fromTable.of(true) });
  }

  /** Start editing the cell at a document position (e.g. where undo put the cursor). */
  activateAt(pos: number): void {
    for (let r = 0; r < this.model.rows.length; r++) {
      const row = this.model.rows[r];
      if (pos < row.from || pos > row.to) continue;
      let col = row.cells.findIndex((c) => pos <= c.slotTo);
      if (col < 0) col = Math.max(0, row.cells.length - 1);
      const cell = row.cells[col];
      this.activate(r, col, cell ? Math.max(0, Math.min(pos, cell.to) - cell.from) : "end");
      return;
    }
    this.activate(0, 0, "end");
  }

  /** Arrive from the text above (dir 1) or below (dir -1), keeping the cursor's column. */
  enter(dir: 1 | -1, x: number | undefined): void {
    const row = dir > 0 ? 0 : this.model.rows.length - 1;
    let col = 0;
    if (x !== undefined) {
      const hit = this.cellEls[row].findIndex((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x <= r.right; });
      if (hit >= 0) col = hit;
      else if (x > (this.cellEls[row].at(-1)?.getBoundingClientRect().right ?? 0)) col = this.model.cols - 1;
    }
    this.activate(row, col, x === undefined ? "end" : { x, y: dir > 0 ? "top" : "bottom" });
  }

  private mount(row: number, col: number, place: Place, range: { from: number; to: number }): void {
    this.unmount();
    const host = this.cellEls[row]?.[col];
    if (!host) return;
    const editor = new EditorView({
      doc: this.view.state.doc.sliceString(range.from, range.to),
      extensions: [
        this.view.state.facet(tableCellSetup),
        // After the setup so that an open autocomplete popup still gets Enter/arrows first,
        // but ahead of the markdown keymap (Enter would otherwise add a line).
        Prec.highest(keymap.of(this.cellKeys())),
        cellInput,
        EditorView.updateListener.of((u) => this.push(u)),
        EditorView.domEventHandlers({
          blur: () => {
            // Leave the cell when focus moves elsewhere in the note, but not when the
            // whole webview loses focus (switching to another VS Code panel).
            setTimeout(() => {
              if (this.active?.editor === editor && !editor.hasFocus && document.hasFocus() && !menuOpen()) this.unmount();
            }, 0);
          },
        }),
      ],
    });
    host.replaceChildren(editor.dom);
    host.classList.add("lm-cell-active");
    this.active = { row, col, editor };
    editor.focus();
    this.placeCursor(editor, place);
    this.view.requestMeasure();
  }

  private placeCursor(editor: EditorView, place: Place): void {
    const len = editor.state.doc.length;
    let pos = len;
    if (place === "start") pos = 0;
    else if (typeof place === "number") pos = Math.max(0, Math.min(place, len));
    else if (typeof place === "object") {
      const rect = editor.contentDOM.getBoundingClientRect();
      const y = place.y === "top" ? rect.top + 2 : place.y === "bottom" ? rect.bottom - 2 : Math.max(rect.top + 1, Math.min(place.y, rect.bottom - 1));
      const x = Math.max(rect.left, Math.min(place.x, rect.right - 1));
      pos = editor.posAtCoords({ x, y }, false);
    }
    editor.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  }

  private unmount(rerender = true): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    a.editor.destroy();
    const host = this.cellEls[a.row]?.[a.col];
    if (host && rerender) {
      host.classList.remove("lm-cell-active");
      renderCell(host, this.model.rows[a.row]?.cells[a.col]?.text ?? "");
    }
  }

  /** Write a cell editor's changes into the cell's markdown. */
  private push(u: ViewUpdate): void {
    if (!u.docChanged || u.transactions.every((tr) => tr.annotation(mirrored))) return;
    const range = this.view.state.field(activeCellField);
    if (!range || !this.active || range.to - range.from !== u.startState.doc.length) return;
    const changes: { from: number; to: number; insert: string }[] = [];
    u.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: range.from + fromA, to: range.from + toA, insert: inserted.toString() });
    });
    const userEvent = u.transactions.map((tr) => tr.annotation(Transaction.userEvent)).filter(Boolean).pop();
    this.pushing = true;
    try {
      this.view.dispatch({
        changes,
        selection: { anchor: range.from + u.state.selection.main.head },
        annotations: fromTable.of(true),
        userEvent,
      });
    } finally {
      this.pushing = false;
    }
  }

  // -- keyboard navigation --

  private cellKeys() {
    const onEdge = (v: EditorView, dir: 1 | -1) => {
      const { head, empty } = v.state.selection.main;
      if (!empty) return false;
      const here = v.coordsAtPos(head), edge = v.coordsAtPos(dir < 0 ? 0 : v.state.doc.length);
      return !here || !edge || (dir < 0 ? here.top <= edge.top + 1 : here.bottom >= edge.bottom - 1);
    };
    const caretX = (v: EditorView) => v.coordsAtPos(v.state.selection.main.head)?.left;
    return [
      { key: "Tab", run: () => this.step(1, true) },
      { key: "Shift-Tab", run: () => this.step(-1, false) },
      { key: "Enter", run: () => this.moveRow(1, true) },
      { key: "Mod-Enter", run: () => this.moveRow(1, true) },
      {
        key: "Shift-Enter",
        run: (v: EditorView) => { v.dispatch(v.state.replaceSelection("<br>"), { userEvent: "input" }); return true; },
      },
      { key: "Escape", run: () => this.exit(1) },
      { key: "ArrowUp", run: (v: EditorView) => onEdge(v, -1) && this.moveRow(-1, false, caretX(v)) },
      { key: "ArrowDown", run: (v: EditorView) => onEdge(v, 1) && this.moveRow(1, false, caretX(v)) },
      {
        key: "ArrowLeft",
        run: (v: EditorView) => v.state.selection.main.empty && v.state.selection.main.head === 0 && this.step(-1, false, "end"),
      },
      {
        key: "ArrowRight",
        run: (v: EditorView) => v.state.selection.main.empty && v.state.selection.main.head === v.state.doc.length && this.step(1, false, "start"),
      },
    ];
  }

  /** Move to the next/previous cell, left to right then down. Tab past the end adds a row. */
  private step(dir: 1 | -1, grow: boolean, place: Place = "end"): boolean {
    if (!this.active) return false;
    const { cols, rows } = this.model;
    const index = this.active.row * cols + this.active.col + dir;
    if (index < 0) return true;
    if (index >= rows.length * cols) {
      if (grow) this.insertRow(rows.length, 0);
      return true;
    }
    this.activate(Math.floor(index / cols), index % cols, place);
    return true;
  }

  /** Move up or down a row. Enter on the last row adds one; arrows leave the table. */
  private moveRow(dir: 1 | -1, grow: boolean, x?: number): boolean {
    if (!this.active) return false;
    const row = this.active.row + dir, col = this.active.col;
    if (row < 0) return this.exit(-1);
    if (row >= this.model.rows.length) return grow ? (this.insertRow(row, col), true) : this.exit(1);
    this.activate(row, col, x === undefined ? "end" : { x, y: dir > 0 ? "top" : "bottom" });
    return true;
  }

  /** Put the cursor back in the text after (dir 1) or before (dir -1) the table. */
  private exit(dir: 1 | -1): boolean {
    const { state } = this.view;
    const { from, to } = this.model;
    if (dir < 0 && from === 0) return true;
    const atEnd = dir > 0 && to >= state.doc.length;
    this.unmount();
    this.view.focus();
    this.view.dispatch({
      changes: atEnd ? { from: to, insert: "\n" } : undefined,
      selection: { anchor: dir > 0 ? to + 1 : from - 1 },
      annotations: fromTable.of(true),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  }

  // -- rows, columns, alignment --

  private grid(): string[][] {
    return this.model.rows.map((r) => Array.from({ length: this.model.cols }, (_, i) => r.cells[i]?.text ?? ""));
  }
  private aligns(): Align[] {
    return Array.from({ length: this.model.cols }, (_, i) => this.model.aligns[i] ?? null);
  }

  /** Rewrite the whole table and continue editing at `row`/`col`. */
  private restructure(grid: string[][], aligns: Align[], row: number, col: number, place: Place = "end"): void {
    const text = serialize(grid, aligns);
    if (text === this.view.state.sliceDoc(this.model.from, this.model.to)) {
      this.activate(row, col, place);
      return;
    }
    const lines = text.split("\n");
    const lineIndex = row === 0 ? 0 : row + 1; // skip the delimiter row
    let offset = this.model.from;
    for (let i = 0; i < lineIndex; i++) offset += lines[i].length + 1;
    const cell = splitRow(lines[lineIndex])[col];
    const from = offset + cell.from, to = offset + cell.to;
    this.pending = { row, col, place };
    this.view.dispatch({
      changes: { from: this.model.from, to: this.model.to, insert: text },
      selection: { anchor: from },
      effects: setActiveCell.of({ from, to }),
      annotations: fromTable.of(true),
      userEvent: "input.table",
    });
  }

  insertRow(at: number, col: number): void {
    const grid = this.grid();
    grid.splice(Math.max(1, at), 0, Array(this.model.cols).fill(""));
    this.restructure(grid, this.aligns(), Math.max(1, at), col);
  }
  deleteRow(row: number, col: number): void {
    if (row === 0) return;
    const grid = this.grid();
    grid.splice(row, 1);
    this.restructure(grid, this.aligns(), Math.min(row, grid.length - 1), col);
  }
  insertColumn(at: number, row: number): void {
    const grid = this.grid(), aligns = this.aligns();
    for (const r of grid) r.splice(at, 0, "");
    aligns.splice(at, 0, null);
    this.restructure(grid, aligns, row, at);
  }
  deleteColumn(col: number, row: number): void {
    if (this.model.cols <= 1) return;
    const grid = this.grid(), aligns = this.aligns();
    for (const r of grid) r.splice(col, 1);
    aligns.splice(col, 1);
    this.restructure(grid, aligns, row, Math.min(col, this.model.cols - 2));
  }
  setAlign(col: number, align: Align, row: number): void {
    const aligns = this.aligns();
    aligns[col] = aligns[col] === align ? null : align;
    this.restructure(this.grid(), aligns, row, col);
  }

  // -- mouse --

  private onMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (this.active?.editor.dom.contains(target)) return; // the cell editor handles its own clicks
    e.preventDefault();
    if (e.button !== 0 || target.closest(".lm-table-add")) return;
    const link = target.closest<HTMLElement>("a[href], [data-wiki]");
    if (link) {
      followLink(link, e.ctrlKey || e.metaKey);
      return;
    }
    const cell = target.closest<HTMLElement>("td, th");
    if (cell) this.activate(Number(cell.dataset.row), Number(cell.dataset.col), { x: e.clientX, y: e.clientY });
  }

  private onContextMenu(e: MouseEvent): void {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("td, th");
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    const row = Number(cell.dataset.row), col = Number(cell.dataset.col);
    const header = row === 0;
    showMenu(e.clientX, e.clientY, [
      { label: "Add row above", disabled: header, run: () => this.insertRow(row, col) },
      { label: "Add row below", run: () => this.insertRow(row + 1, col) },
      { label: "Add column left", run: () => this.insertColumn(col, row) },
      { label: "Add column right", run: () => this.insertColumn(col + 1, row) },
      null,
      { label: "Delete row", disabled: header, run: () => this.deleteRow(row, col) },
      { label: "Delete column", disabled: this.model.cols <= 1, run: () => this.deleteColumn(col, row) },
      null,
      { label: "Align left", checked: this.model.aligns[col] === "left", run: () => this.setAlign(col, "left", row) },
      { label: "Align center", checked: this.model.aligns[col] === "center", run: () => this.setAlign(col, "center", row) },
      { label: "Align right", checked: this.model.aligns[col] === "right", run: () => this.setAlign(col, "right", row) },
    ]);
  }
}

// ---- context menu ----------------------------------------------------------------------------

interface MenuItem { label: string; run: () => void; disabled?: boolean; checked?: boolean }

let menu: HTMLElement | null = null;
const menuOpen = () => menu !== null;

function closeMenu(): void {
  menu?.remove();
  menu = null;
  window.removeEventListener("mousedown", onOutside, true);
  window.removeEventListener("keydown", onMenuKey, true);
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("wheel", closeMenu, true);
}
function onOutside(e: MouseEvent): void {
  if (!menu?.contains(e.target as Node)) closeMenu();
}
function onMenuKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeMenu();
  }
}

function showMenu(x: number, y: number, items: (MenuItem | null)[]): void {
  closeMenu();
  menu = el("div", "lm-menu");
  for (const item of items) {
    if (!item) {
      menu.append(el("div", "lm-menu-separator"));
      continue;
    }
    const row = el("div", `lm-menu-item${item.disabled ? " is-disabled" : ""}${item.checked ? " is-checked" : ""}`, item.label);
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", () => {
      if (item.disabled) return;
      closeMenu();
      item.run();
    });
    menu.append(row);
  }
  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
  window.addEventListener("mousedown", onOutside, true);
  window.addEventListener("keydown", onMenuKey, true);
  window.addEventListener("blur", closeMenu);
  window.addEventListener("wheel", closeMenu, true);
}

// ---- the widget ------------------------------------------------------------------------------

export class TableWidget extends WidgetType {
  private readonly key: string;
  constructor(readonly model: TableModel) {
    super();
    this.key = JSON.stringify(model);
  }
  eq(other: TableWidget) { return other.key === this.key; }
  toDOM(view: EditorView) { return new TableController(view, this.model).dom; }
  updateDOM(dom: HTMLElement, view: EditorView) {
    // Reuse the same DOM (and the cell editor in it) while the table is being edited.
    const controller = controllerOf.get(dom);
    if (!controller || controller.view !== view) return false;
    controller.update(this.model);
    return true;
  }
  destroy(dom: HTMLElement) { controllerOf.get(dom)?.destroy(); }
  get estimatedHeight() { return 34 * this.model.rows.length + 28; }
  ignoreEvent() { return true; }
}

// ---- main editor glue ----------------------------------------------------------------------

/** Arrow keys from the text next to a table go into its cells instead of skipping it. */
function enterTable(view: EditorView, dir: 1 | -1): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const next = view.moveVertically(sel, dir > 0);
  for (const ctl of controllers) {
    if (ctl.view !== view) continue;
    const { from, to } = ctl.model;
    if (dir > 0 ? sel.head < from && next.head >= from : sel.head > to && next.head <= to) {
      ctl.enter(dir, view.coordsAtPos(sel.head)?.left);
      return true;
    }
  }
  return false;
}

/** If the main cursor lands inside a table (undo, find, …), edit that cell instead. */
const cursorIntoTable = ViewPlugin.define((view) => ({
  update(u: ViewUpdate) {
    if (!u.selectionSet || u.transactions.some((tr) => tr.annotation(fromTable))) return;
    const sel = u.state.selection.main;
    if (!sel.empty) return;
    // Table positions are only up to date once this update has been drawn.
    queueMicrotask(() => {
      if (!view.hasFocus || view.state.selection.main.head !== sel.head) return;
      for (const ctl of controllers) {
        if (ctl.view === view && sel.head > ctl.model.from && sel.head < ctl.model.to) {
          ctl.activateAt(sel.head);
          return;
        }
      }
    });
  },
}));

export function tableEditing(): Extension {
  return [
    activeCellField,
    cursorIntoTable,
    Prec.high(keymap.of([
      { key: "ArrowDown", run: (v) => enterTable(v, 1) },
      { key: "ArrowUp", run: (v) => enterTable(v, -1) },
    ])),
  ];
}
