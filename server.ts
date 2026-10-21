import "dotenv/config";
import express from "express";
import path from "path";
import { handleApi } from "./src/http.js";

const app = express();
app.use(express.json({ limit: "32kb" }));

app.use("/api/:route", async (req, res) => {
  try {
    const url = new URL(req.originalUrl, "http://127.0.0.1");
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
    });
    const response = await handleApi(request);
    const body = await response.text();
    res.status(response.status).type("application/json").send(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "The report API failed.";
    res.status(500).json({ message });
  }
});

const PORT = Number(process.env.PORT) || 3200;

async function start() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import("vite");
    const server = app.listen(PORT, () => console.log(`CloudTalk report on http://localhost:${PORT}`));
    const vite = await createServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    app.use(vite.middlewares);
    return;
  }

  const dist = path.join(process.cwd(), "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
  app.listen(PORT, () => console.log(`CloudTalk report on port ${PORT}`));
}

start();

export default app;
