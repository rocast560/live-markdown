// Tiny static file server for the browser harness: node test/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml", ".map": "application/json" };
const port = Number(process.argv[2] ?? 5178);
createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[/\\]+/, "");
  if (path.startsWith("..")) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
