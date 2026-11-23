const express = require("express");
const path = require("node:path");

const app = express();
const port = Number(process.env.PORT) || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// Serve the existing approved AURUM PWA without changing its UI.
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "5m"
}));

// Reuse the same API handler used by Vercel so both hosts share identical
// provider selection, freshness checks, fallback logic and response schema.
const aurumApiHandler = require("./api/index.js");
app.get("/api", aurumApiHandler);
app.get("/api/", aurumApiHandler);

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "online",
    app: "Aurum Signals AI",
    api: "mounted",
    timestamp: new Date().toISOString()
  });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ status: "error", message: "API route tidak ditemukan" });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"), error => {
    if (error) next(error);
  });
});

app.use((error, req, res, next) => {
  console.error("AURUM server error:", error);
  if (res.headersSent) return next(error);
  res.status(500).json({ status: "error", message: "Terjadi kesalahan server" });
});

if (require.main === module) {
  app.listen(port, "0.0.0.0", () => {
    console.log("AURUM Signals AI listening on port " + port);
  });
}

module.exports = app;
