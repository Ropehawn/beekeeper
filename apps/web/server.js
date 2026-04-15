const express = require("express");
const path = require("path");
const http = require("http");
const https = require("https");

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const API_URL = process.env.API_URL || "http://localhost:3001";

// Inject API URL into the page as a global variable
app.get("/config.js", (_req, res) => {
  // In production, proxy through this server so we use '' (same origin).
  // The proxy below handles /api/* → API_URL.
  res.type("application/javascript");
  res.send(`window.__BEEKEEPER_API_URL = '';`);
});

// Proxy /api/* requests to the API service
app.use("/api", (req, res) => {
  const url = new URL(req.url, API_URL);
  url.pathname = "/api" + url.pathname;

  const proto = url.protocol === "https:" ? https : http;
  const proxyReq = proto.request(url.toString(), {
    method: req.method,
    headers: {
      ...req.headers,
      host: url.host,
    },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message);
    res.status(502).json({ error: "API service unavailable" });
  });

  req.pipe(proxyReq, { end: true });
});

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// SPA fallback — serve index.html for all routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`BeeKeeper web running on port ${PORT}`);
  console.log(`API proxy → ${API_URL}`);
});
