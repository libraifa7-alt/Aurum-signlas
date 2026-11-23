const express = require("express");
const path = require("path");
const marketApi = require("./api/index.js");

const app = express();
const port = Number(process.env.PORT) || 10000;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

// Health check is intentionally independent of market-provider availability.
app.get("/api/health", (_req, res) => {
  res.status(200).json({
    status: "online",
    app: "Aurum Signals AI",
    runtime: "Render",
    marketApi: "mounted"
  });
});

// Keep the same API contract used by the existing frontend on Vercel.
app.get("/api", (req, res, next) => {
  Promise.resolve(marketApi(req, res)).catch(next);
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "1h",
  setHeaders(res, filePath) {
    if (filePath.endsWith("service-worker.js") || filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error("AURUM SERVER ERROR:", error.message);
  if (res.headersSent) return;
  res.status(500).json({
    status: "error",
    message: "Terjadi kesalahan pada server AURUM"
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`AURUM Signals AI listening on 0.0.0.0:${port}`);
});
