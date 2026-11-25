import http from "http";
import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const port = Number(process.argv[3] || 5500);

const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

http.createServer((req, res) => {
  let filePath = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(port, () => console.log(`Static server for ${root} on http://localhost:${port}`));
