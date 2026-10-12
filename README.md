# Live Markdown

A VS Code editor for markdown files that works like Obsidian's live preview. The file stays plain markdown, but formatting is drawn as you type and the raw syntax only shows up on the part you're editing.

I wanted the same editing feel I get in Obsidian while working in VS Code, so that's what this does. It's built on CodeMirror 6, which is also what Obsidian's editor runs on.

## What it renders

- Bold, italic, strikethrough, `==highlight==` and inline code. The markers come back when the cursor touches the text.
- Headings. The `#` marks show on the line you're on.
- Links, `[[wikilinks]]` and `[[Note|aliases]]`. Clicking a link follows it and Ctrl+click opens it to the side. Links to notes that don't exist yet are faded, and following one creates the note. Typing `[[` suggests note names.
- Bullet and numbered lists with hanging indents, and task checkboxes you can click.
- Blockquotes and callouts like `> [!note] Title`. Put a `-` after the type (`> [!faq]-`) to start the callout folded, or a `+` to make it foldable but open. The chevron next to the title folds and unfolds it without changing the file.
- Tables, which stay rendered and are edited one cell at a time (see below).
- Math with `$...$` and `$$...$$` through MathJax, mermaid diagrams, and code blocks with highlighting and a copy button.
- Images, `![[embeds]]` of other notes or of one section of a note, frontmatter as a properties panel, `#tags`, `%%comments%%` and footnotes.

## Tables

Click a cell to edit it. Tab and Shift+Tab move between cells, and Tab on the last cell adds a row. Enter moves down a row and adds one at the bottom. The arrow keys move between cells and in and out of the table, Shift+Enter puts a `<br>` in the cell, and Esc leaves the table.

Right-click a cell to add or delete rows and columns or change a column's alignment. You can also use the + bars that show up on the right and bottom edges when you hover over the table. If you type a `|` it gets escaped so it doesn't split the cell.

Adding or removing rows and columns rewrites the table in a standard layout, while editing a cell only touches that cell. To see the raw table, switch to source mode.

## Using it

Once it's installed, `.md` files open in this editor by default. To get the normal text editor back for a file, click "Open as Plain Text" in the editor toolbar or use Reopen Editor With.

The button in the top right corner of a note switches between live preview and source mode. The book icon in the toolbar does the same.

Shortcuts: Ctrl+B for bold, Ctrl+I for italic, Ctrl+F to find, Ctrl+Z and Ctrl+Y to undo and redo, and Tab or Shift+Tab to indent lists. Enter continues a list.

## Settings

Everything is under `liveMarkdown.` in the VS Code settings.

- `look` picks which Obsidian theme to copy. `minimal` is the Minimal theme set up the way I use it, with colored headings, an orange accent (#ff6c52), the Bahnschrift font, round checkboxes and outlined tags. `default` is Obsidian's stock theme.
- `colorScheme` set to `vscode` uses your VS Code theme's background and text colors.
- `headingColor` sets one color for every heading and `headingColors` sets them per level, for example `{ "h1": "#e06c75" }`. Both take any CSS color.
- `accentColor` changes the color of links, tags and checkboxes.
- `fontSize`, `fontFamily`, `monospaceFontFamily`, `readableLineLength`, `lineWidth` and `showInlineTitle` do what they say.

The colors, sizes and spacing come from Obsidian's default theme and from the Minimal theme by kepano.

## Building

You need Node 20 or newer and VS Code.

```
npm install
npm run build      # bundles into dist/ and media/
npm test           # integration tests in a throwaway VS Code profile
npm run package    # makes live-markdown.vsix
```

Then install it with `code --install-extension live-markdown.vsix`.

`test/harness.html` runs the editor in a normal browser with a fake VS Code host, which is quicker for checking how things look. Start `node test/serve.mjs` and open http://127.0.0.1:5178/test/harness.html.
