import "dotenv/config";
import express from "express";
import path from "path";
import { buildReport, credentialsConfigured, saveCredentials } from "./src/cloudtalk.js";
import { buildFrejunReport, frejunConfigured } from "./src/frejun.js";

const authFailure = (message: string) => /unauthor|forbidden|rejected the key|\b401\b|\b403\b/i.test(message);

const app = express();
app.use(express.json({ limit: "32kb" }));

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

const defaultRange = () => {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 29);
  const iso = (date: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  return { from: iso(from), to: iso(to) };
};

app.get("/api/status", (_req, res) => {
  res.json({ configured: credentialsConfigured(), frejunConfigured: frejunConfigured() });
});

app.post("/api/credentials", (req, res) => {
  try {
    saveCredentials(String(req.body?.keyId ?? ""), String(req.body?.keySecret ?? ""));
    res.json({ configured: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save the API key.";
    res.status(400).json({ message });
  }
});

app.get("/api/frejun", async (req, res) => {
  if (!frejunConfigured()) {
    res.status(503).json({ message: "Add FREJUN_API_KEY to .env, then refresh." });
    return;
  }
  const fallback = defaultRange();
  const from = String(req.query.from || fallback.from);
  const to = String(req.query.to || fallback.to);
  if (!dayPattern.test(from) || !dayPattern.test(to) || from > to) {
    res.status(400).json({ message: "Use a from date and a to date as YYYY-MM-DD, with from on or before to." });
    return;
  }
  try {
    res.json(await buildFrejunReport(from, to));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Frejun could not be reached.";
    const status = /unauthor|401|403/i.test(message) ? 401 : 502;
    res.status(status).json({ message });
  }
});

app.get("/api/report", async (req, res) => {
  if (!credentialsConfigured()) {
    res.status(503).json({
      code: "NOT_CONFIGURED",
      message: "Add the CloudTalk Access Key ID and Secret, then load the report again.",
    });
    return;
  }

  const fallback = defaultRange();
  const from = String(req.query.from || fallback.from);
  const to = String(req.query.to || fallback.to);
  if (!dayPattern.test(from) || !dayPattern.test(to) || from > to) {
    res.status(400).json({ message: "Use a from date and a to date as YYYY-MM-DD, with from on or before to." });
    return;
  }
  const span = (Date.parse(`${to}T00:00:00`) - Date.parse(`${from}T00:00:00`)) / 86_400_000;
  if (span > 366) {
    res.status(400).json({ message: "Pick a range of 366 days or fewer." });
    return;
  }

  try {
    const report = await buildReport(from, to);
    const failures = report.sources.filter((item) => item.error);
    if (failures.length === report.sources.length) {
      const message = failures[0]?.error || "CloudTalk did not return any data.";
      res.status(authFailure(message) ? 401 : 502).json({
        code: authFailure(message) ? "UNAUTHORIZED" : "UPSTREAM",
        message,
      });
      return;
    }
    res.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : "CloudTalk could not be reached.";
    res.status(502).json({ code: "UPSTREAM_UNREACHABLE", message });
  }
});

const PORT = Number(process.env.PORT) || 3200;

if (process.env.NODE_ENV !== "production") {
  const { createServer } = await import("vite");
  const server = app.listen(PORT, () => console.log(`CloudTalk report on http://localhost:${PORT}`));
  const vite = await createServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const dist = path.join(process.cwd(), "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
  app.listen(PORT, () => console.log(`CloudTalk report on port ${PORT}`));
}

export default app;
