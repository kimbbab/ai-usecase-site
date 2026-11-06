// Render(또는 내 컴퓨터)용: 화면 + /api/chat 을 한 서버에서.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleChat, hasKey, readJson } from "./lib/chat.mjs";
import { handlePosts, hasStore } from "./lib/store.mjs";
import { handleNews, handleNewsRefresh } from "./lib/news.mjs";
import { handleCornerMinutes, handleCornerChat, handleCornerFile } from "./lib/corner.mjs";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = process.env.PORT || 3000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon" };

function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
  if (p === "/") p = "/index.html";
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("없는 페이지예요."); return; }
    const ext = path.extname(file);
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": ext === ".html" ? "no-cache" : "public, max-age=86400" });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/api/chat") return void handleChat(req, res);
  if (url === "/api/posts") return void handlePosts(req, res, readJson);
  if (url === "/api/news") return void handleNews(req, res);
  if (url === "/api/news-refresh") return void handleNewsRefresh(req, res);
  if (url === "/api/corner-minutes") return void handleCornerMinutes(req, res, readJson);
  if (url === "/api/corner-chat") return void handleCornerChat(req, res, readJson);
  if (url === "/api/corner-file") return void handleCornerFile(req, res, readJson);
  if (url === "/healthz") return void res.writeHead(200).end("ok");
  if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
  serveStatic(req, res);
}).listen(PORT, () => console.log(`listening on ${PORT}, key ${hasKey ? "set" : "MISSING"}, store ${hasStore ? "set" : "MISSING"}`));
