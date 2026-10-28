import type { Bucket } from "./types.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 8;

type Json = Record<string, unknown>;

export type FrejunCall = {
  id: string;
  startedAt: string | null;
  direction: string;
  status: string;
  answered: boolean;
  virtualNumber: string;
  externalNumber: string;
  contactName: string;
  agentName: string;
  durationSeconds: number;
  outcome: string;
  reason: string;
  notes: string;
};

export type FrejunLine = {
  id: string;
  name: string;
  e164: string;
  calls: number;
  answered: number;
  missed: number;
  incoming: number;
  outgoing: number;
  talkSeconds: number;
  answerRate: number | null;
  agents: number;
};

export type FrejunAgent = {
  name: string;
  calls: number;
  answered: number;
  missed: number;
  talkSeconds: number;
};

export type FrejunReport = {
  fetchedAt: string;
  range: { from: string; to: string };
  summary: {
    callsLoaded: number;
    callsTotal: number | null;
    callsTruncated: boolean;
    answered: number;
    missed: number;
    incoming: number;
    outgoing: number;
    talkSeconds: number;
    answerRate: number | null;
    agents: number;
    numbers: number;
  };
  lines: FrejunLine[];
  agents: FrejunAgent[];
  calls: FrejunCall[];
  daily: Bucket[];
};

export const frejunConfigured = () => Boolean((process.env.FREJUN_API_KEY || "").trim());

const asRecord = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

const text = (value: unknown) => (value == null ? "" : String(value).trim());

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const phone = (value: unknown) => {
  const raw = text(value).replace(/\s+/g, "");
  if (!raw) return "";
  return raw.startsWith("+") ? raw : `+${raw}`;
};

const baseUrl = () => (process.env.FREJUN_API_BASE || "https://api.frejun.com").trim().replace(/\/+$/, "");

const frejunStamp = (day: string, time: string, end: boolean) => {
  const [year, month, date] = day.split("-");
  return `${date}/${month}/${year.slice(2)} ${time}:${end ? "59" : "00"}`;
};

const answeredStatus = (status: string, durationSeconds: number) =>
  status === "answered" || (durationSeconds > 0 && !status.includes("not-answered") && !status.includes("not-initiated"));

const eachDay = (from: string, to: string) => {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end && days.length < 370) {
    const pad = (n: number) => String(n).padStart(2, "0");
    days.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
};

const dayKey = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const mapCall = (row: Json): FrejunCall => {
  const status = text(row.status) || "unknown";
  const minutes = num(row.call_duration);
  const durationSeconds = Math.round(minutes * 60);
  const virtualNumber = phone(row.virtual_number);
  return {
    id: text(row.call_id) || text(row.id),
    startedAt: text(row.call_start_time) || null,
    direction: text(row.call_type) || "unknown",
    status,
    answered: answeredStatus(status, durationSeconds),
    virtualNumber,
    externalNumber: phone(row.candidate_number),
    contactName: text(row.candidate_name),
    agentName: text(row.recruiter) || "Unassigned",
    durationSeconds,
    outcome: text(row.call_outcome),
    reason: text(row.call_reason),
    notes: text(row.recruiter_notes),
  };
};

const fetchJson = async (url: string) => {
  const key = (process.env.FREJUN_API_KEY || "").trim();
  const res = await fetch(url, { headers: { Authorization: `Api-Key ${key}`, Accept: "application/json" } });
  const body = await res.text();
  let json: unknown = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    json = { message: body.slice(0, 240) };
  }
  return { status: res.status, json: asRecord(json) };
};

export const buildFrejunReport = async (from: string, to: string, fromTime = "00:00", toTime = "23:59"): Promise<FrejunReport> => {
  if (!frejunConfigured()) throw new Error("Add FREJUN_API_KEY to .env, then refresh.");

  const params = new URLSearchParams({
    page_size: String(PAGE_SIZE),
    date: frejunStamp(from, fromTime, false),
    date_end: frejunStamp(to, toTime, true),
  });
  let nextUrl: string | null = `${baseUrl()}/api/v1/integrations/calls/?${params}`;
  const calls: FrejunCall[] = [];
  let total: number | null = null;
  let pages = 0;

  while (nextUrl && pages < MAX_PAGES) {
    const { status, json } = await fetchJson(nextUrl);
    if (status === 429) throw new Error("Frejun rate limit exceeded. Wait a minute and refresh.");
    if (status >= 400 || json.success === false) {
      const detail = asRecord(json.message);
      const message = typeof json.message === "string" ? json.message : text(detail.detail);
      throw new Error(message || `Frejun returned ${status}.`);
    }
    if (total == null) total = num(json.count) || null;
    const results = Array.isArray(json.results) ? json.results : Array.isArray(asRecord(json.data).results) ? (asRecord(json.data).results as unknown[]) : [];
    for (const row of results) calls.push(mapCall(asRecord(row)));
    pages += 1;
    nextUrl = text(json.next) || null;
    if (!results.length) break;
  }

  const byNumber = new Map<string, FrejunCall[]>();
  for (const call of calls) {
    const key = call.virtualNumber || "Unknown number";
    const list = byNumber.get(key) ?? [];
    list.push(call);
    byNumber.set(key, list);
  }

  const lines: FrejunLine[] = [...byNumber.entries()]
    .map(([e164, rows]) => {
      const answered = rows.filter((call) => call.answered).length;
      const talkSeconds = rows.reduce((sum, call) => sum + call.durationSeconds, 0);
      return {
        id: e164,
        name: e164,
        e164,
        calls: rows.length,
        answered,
        missed: rows.length - answered,
        incoming: rows.filter((call) => call.direction === "incoming").length,
        outgoing: rows.filter((call) => call.direction === "outgoing").length,
        talkSeconds,
        answerRate: rows.length ? answered / rows.length : null,
        agents: new Set(rows.map((call) => call.agentName).filter((name) => name && name !== "Unassigned")).size,
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const agentMap = new Map<string, FrejunAgent>();
  for (const call of calls) {
    const row = agentMap.get(call.agentName) ?? { name: call.agentName, calls: 0, answered: 0, missed: 0, talkSeconds: 0 };
    row.calls += 1;
    row.talkSeconds += call.durationSeconds;
    if (call.answered) row.answered += 1;
    else row.missed += 1;
    agentMap.set(call.agentName, row);
  }

  const dailyMap = new Map<string, Bucket>(
    eachDay(from, to).map((day) => [day, { key: day, label: day.slice(5), calls: 0, answered: 0, missed: 0, talkSeconds: 0 }]),
  );
  for (const call of calls) {
    const bucket = dailyMap.get(dayKey(call.startedAt));
    if (!bucket) continue;
    bucket.calls += 1;
    bucket.talkSeconds += call.durationSeconds;
    if (call.answered) bucket.answered += 1;
    else bucket.missed += 1;
  }

  const answered = calls.filter((call) => call.answered).length;
  const talkSeconds = calls.reduce((sum, call) => sum + call.durationSeconds, 0);

  return {
    fetchedAt: new Date().toISOString(),
    range: { from, to },
    summary: {
      callsLoaded: calls.length,
      callsTotal: total,
      callsTruncated: total != null && calls.length < total,
      answered,
      missed: calls.length - answered,
      incoming: calls.filter((call) => call.direction === "incoming").length,
      outgoing: calls.filter((call) => call.direction === "outgoing").length,
      talkSeconds,
      answerRate: calls.length ? answered / calls.length : null,
      agents: agentMap.size,
      numbers: lines.length,
    },
    lines,
    agents: [...agentMap.values()].sort((a, b) => b.calls - a.calls),
    calls: calls.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")),
    daily: [...dailyMap.values()],
  };
};
