import "dotenv/config";
import { buildReport, credentialsConfigured, saveCredentials, type TimeWindow } from "./cloudtalk.js";
import { buildFrejunReport, frejunConfigured } from "./frejun.js";

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const routes = new Set(["status", "report", "credentials", "frejun"]);

const authFailure = (message: string) => /unauthor|forbidden|rejected the key|\b401\b|\b403\b/i.test(message);

const onVercel = () => Boolean(process.env.VERCEL);

const json = (status: number, body: unknown): Response => Response.json(body, { status });

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

const routeOf = (url: URL) => {
  const named = url.searchParams.get("route");
  if (named && routes.has(named)) return named;
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
};

type Range = { from: string; to: string; fromTime: string; toTime: string; window: TimeWindow | null };

const readRange = (url: URL): { ok: false; response: Response } | ({ ok: true } & Range) => {
  const fallback = defaultRange();
  const from = url.searchParams.get("from") || fallback.from;
  const to = url.searchParams.get("to") || fallback.to;
  const fromTime = url.searchParams.get("fromTime") || "00:00";
  const toTime = url.searchParams.get("toTime") || "23:59";
  if (!dayPattern.test(from) || !dayPattern.test(to) || from > to) {
    return { ok: false, response: json(400, { message: "Use a from date and a to date as YYYY-MM-DD, with from on or before to." }) };
  }
  if (!timePattern.test(fromTime) || !timePattern.test(toTime) || `${from} ${fromTime}` > `${to} ${toTime}`) {
    return { ok: false, response: json(400, { message: "Use times as HH:MM, with the start on or before the end." }) };
  }
  const start = url.searchParams.get("start") || "";
  const end = url.searchParams.get("end") || "";
  const window = Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end)) ? { start, end } : null;
  return { ok: true, from, to, fromTime, toTime, window };
};

export const handleApi = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const route = routeOf(url);

  if (request.method === "GET" && route === "status") {
    return json(200, {
      configured: credentialsConfigured(),
      frejunConfigured: frejunConfigured(),
      host: onVercel() ? "vercel" : "local",
    });
  }

  if (request.method === "POST" && route === "credentials") {
    if (onVercel()) {
      return json(400, {
        message: "Set CLOUDTALK_KEY_ID and CLOUDTALK_KEY_SECRET in the Vercel project environment variables, then redeploy.",
      });
    }
    try {
      const body = (await request.json()) as { keyId?: unknown; keySecret?: unknown };
      saveCredentials(String(body?.keyId ?? ""), String(body?.keySecret ?? ""));
      return json(200, { configured: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save the API key.";
      return json(400, { message });
    }
  }

  if (request.method === "GET" && route === "frejun") {
    if (!frejunConfigured()) {
      return json(503, {
        message: onVercel()
          ? "Add FREJUN_API_KEY in the Vercel project environment variables, then redeploy."
          : "Add FREJUN_API_KEY to .env, then refresh.",
      });
    }
    const range = readRange(url);
    if (!range.ok) return range.response;
    try {
      return json(200, await buildFrejunReport(range.from, range.to, range.fromTime, range.toTime));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Frejun could not be reached.";
      const status = /unauthor|401|403/i.test(message) ? 401 : 502;
      return json(status, { message });
    }
  }

  if (request.method === "GET" && route === "report") {
    if (!credentialsConfigured()) {
      return json(503, {
        code: "NOT_CONFIGURED",
        message: onVercel()
          ? "Set CLOUDTALK_KEY_ID and CLOUDTALK_KEY_SECRET in the Vercel project environment variables, then redeploy."
          : "Add the CloudTalk Access Key ID and Secret, then load the report again.",
      });
    }
    const range = readRange(url);
    if (!range.ok) return range.response;
    const span = (Date.parse(`${range.to}T00:00:00`) - Date.parse(`${range.from}T00:00:00`)) / 86_400_000;
    if (span > 366) return json(400, { message: "Pick a range of 366 days or fewer." });

    try {
      const report = await buildReport(range.from, range.to, range.window);
      const failures = report.sources.filter((item) => item.error);
      if (failures.length === report.sources.length) {
        const message = failures[0]?.error || "CloudTalk did not return any data.";
        return json(authFailure(message) ? 401 : 502, {
          code: authFailure(message) ? "UNAUTHORIZED" : "UPSTREAM",
          message,
        });
      }
      return json(200, report);
    } catch (err) {
      const message = err instanceof Error ? err.message : "CloudTalk could not be reached.";
      return json(502, { code: "UPSTREAM_UNREACHABLE", message });
    }
  }

  return json(404, { message: "That API route does not exist." });
};
