import { useEffect, useMemo, useRef, useState } from "react";
import type { Bucket, CallRow, Report, SourceStatus } from "./types";
import type { FrejunReport } from "./frejun";

const iso = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const initialRange = () => {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 29);
  return { from: iso(from), to: iso(to) };
};

const duration = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${rest}s`;
  return `${rest}s`;
};

const percent = (value: number | null) => (value == null ? "—" : `${Math.round(value * 100)}%`);

const when = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const titleCase = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : "—");

const dayKey = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return iso(date);
};

const bucketsFor = (calls: { startedAt: string | null; answered: boolean; talkingSeconds: number }[], from: string, to: string): Bucket[] => {
  const buckets: Bucket[] = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end && buckets.length < 370) {
    const key = iso(cursor);
    buckets.push({ key, label: key.slice(5), calls: 0, answered: 0, missed: 0, talkSeconds: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  const byDay = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  for (const call of calls) {
    const bucket = byDay.get(dayKey(call.startedAt));
    if (!bucket) continue;
    bucket.calls += 1;
    bucket.talkSeconds += call.talkingSeconds;
    if (call.answered) bucket.answered += 1;
    else bucket.missed += 1;
  }
  return buckets;
};

const downloadCalls = (calls: CallRow[]) => {
  const header = ["Line", "Started", "Direction", "Result", "Agent", "Contact", "Company", "External number", "Talk seconds", "Wait seconds", "Tags"];
  const lines = calls.map((call) =>
    [
      call.lineName,
      call.startedAt ?? "",
      call.direction,
      call.answered ? "answered" : "missed",
      call.agentName,
      call.contactName,
      call.company,
      call.externalNumber,
      String(call.talkingSeconds),
      String(call.waitingSeconds),
      call.tags.join("|"),
    ]
      .map((cell) => `"${cell.replaceAll('"', '""')}"`)
      .join(","),
  );
  const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "cloudtalk-calls.csv";
  link.click();
  URL.revokeObjectURL(url);
};

export const App = () => {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [host, setHost] = useState<"local" | "vercel">("local");
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [range, setRange] = useState(initialRange);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("all");
  const [result, setResult] = useState("all");
  const [lineId, setLineId] = useState("all");
  const [source, setSource] = useState<"cloudtalk" | "frejun">("cloudtalk");
  const [frejun, setFrejun] = useState<FrejunReport | null>(null);
  const [frejunLoading, setFrejunLoading] = useState(false);
  const [frejunError, setFrejunError] = useState("");
  const [frejunLine, setFrejunLine] = useState("all");

  const loadReport = async (next = range) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ from: next.from, to: next.to });
      const res = await fetch(`/api/report?${params}`);
      const body = await res.json();
      if (!res.ok) {
        if (res.status === 503 || res.status === 401) setConfigured(false);
        throw new Error(body.message || "The report could not be loaded.");
      }
      setReport(body as Report);
      setConfigured(true);
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : "The report could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetch("/api/status")
      .then(async (res) => {
        const body = (await res.json()) as { configured?: boolean; host?: string };
        if (!res.ok || typeof body.configured !== "boolean") {
          throw new Error("The report API is not responding.");
        }
        return { configured: body.configured, host: body.host };
      })
      .then((body) => {
        setConfigured(body.configured);
        if (body.host === "vercel") setHost("vercel");
        if (body.configured) void loadReport();
      })
      .catch(() => setError("The report API is not responding."));
    // Load once on open; later loads go through the date form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadFrejun = async (next = range) => {
    setFrejunLoading(true);
    setFrejunError("");
    try {
      const params = new URLSearchParams({ from: next.from, to: next.to });
      const res = await fetch(`/api/frejun?${params}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "Frejun could not be loaded.");
      setFrejun(body as FrejunReport);
    } catch (err) {
      setFrejun(null);
      setFrejunError(err instanceof Error ? err.message : "Frejun could not be loaded.");
    } finally {
      setFrejunLoading(false);
    }
  };

  const saveKey = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId, keySecret }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "Could not save the key.");
      setKeyId("");
      setKeySecret("");
      setConfigured(true);
      await loadReport();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the key.");
    } finally {
      setSaving(false);
    }
  };

  const lineCalls = useMemo(
    () => (report?.calls ?? []).filter((call) => lineId === "all" || call.lineId === lineId),
    [report, lineId],
  );

  const filteredCalls = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lineCalls.filter((call) => {
      if (direction !== "all" && call.direction !== direction) return false;
      if (result === "answered" && !call.answered) return false;
      if (result === "missed" && call.answered) return false;
      if (!needle) return true;
      return [call.agentName, call.contactName, call.company, call.externalNumber, call.internalNumber, call.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [lineCalls, query, direction, result]);

  const selectedLine = report?.lines.find((line) => line.id === lineId) ?? null;

  const visibleAgents = useMemo(() => {
    if (!report) return [];
    if (lineId === "all") return report.agents;
    const counts = new Map<string, { calls: number; answered: number; missed: number; talkSeconds: number }>();
    for (const call of lineCalls) {
      const row = counts.get(call.agentId) ?? { calls: 0, answered: 0, missed: 0, talkSeconds: 0 };
      row.calls += 1;
      row.talkSeconds += call.talkingSeconds;
      if (call.answered) row.answered += 1;
      else row.missed += 1;
      counts.set(call.agentId, row);
    }
    return report.agents
      .filter((agent) => agent.lineIds.includes(lineId) || counts.has(agent.id))
      .map((agent) => ({ ...agent, ...(counts.get(agent.id) ?? { calls: 0, answered: 0, missed: 0, talkSeconds: 0 }) }))
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  }, [report, lineId, lineCalls]);

  const daily = useMemo(() => (report ? bucketsFor(lineCalls, report.range.from, report.range.to) : []), [report, lineCalls]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-[0.16em] text-[var(--teal)] uppercase">Call report</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{source === "cloudtalk" ? "CloudTalk" : "Frejun"}</h1>
          <p className="mt-1 max-w-xl text-sm text-[var(--muted)]">
            {source === "cloudtalk"
              ? "Live data from the CloudTalk key in .env: calls, agents, contacts, numbers, groups, tags, and notes."
              : "Calls, virtual numbers, and users from the Frejun key in .env."}
          </p>
        </div>
        {(source === "frejun" || configured) && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (source === "frejun") void loadFrejun();
              else void loadReport();
            }}
          >
            <label className="text-xs text-[var(--muted)]">
              From
              <input
                type="date"
                value={range.from}
                onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))}
                className="mt-1 block rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5"
              />
            </label>
            <label className="text-xs text-[var(--muted)]">
              To
              <input
                type="date"
                value={range.to}
                onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))}
                className="mt-1 block rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5"
              />
            </label>
            <button
              type="submit"
              disabled={source === "frejun" ? frejunLoading : loading}
              className="rounded-md bg-[var(--teal)] px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {source === "frejun" ? (frejunLoading ? "Loading…" : "Refresh") : loading ? "Loading…" : "Refresh"}
            </button>
            {source === "cloudtalk" && (
            <button
              type="button"
              onClick={() => {
                setConfigured(false);
                setReport(null);
              }}
              className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm"
            >
              Change key
            </button>
            )}
          </form>
        )}
      </header>

      <div className="mb-6 flex w-fit gap-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-1">
        <button
          type="button"
          onClick={() => setSource("cloudtalk")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${source === "cloudtalk" ? "bg-[var(--teal)] text-white" : "text-[var(--muted)]"}`}
        >
          CloudTalk
        </button>
        <button
          type="button"
          onClick={() => {
            setSource("frejun");
            if (!frejun && !frejunLoading) void loadFrejun();
          }}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${source === "frejun" ? "bg-[var(--teal)] text-white" : "text-[var(--muted)]"}`}
        >
          Frejun
        </button>
      </div>

      {source === "frejun" && (
        <FrejunPanel
          report={frejun}
          loading={frejunLoading}
          error={frejunError}
          lineId={frejunLine}
          onLine={setFrejunLine}
        />
      )}

      {source === "cloudtalk" && error && (
        <p className="mb-4 rounded-lg border border-[#efc8c4] bg-[var(--red-soft)] px-3 py-2 text-sm text-[var(--red)]">{error}</p>
      )}

      {source === "cloudtalk" && configured === null && !error && <p className="text-sm text-[var(--muted)]">Checking the API key…</p>}

      {source === "cloudtalk" && configured === false && host === "vercel" && (
        <section className="max-w-lg rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="text-lg font-semibold">Connect CloudTalk</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            In the Vercel project, open Settings → Environment Variables and add <span className="mono">CLOUDTALK_KEY_ID</span> and <span className="mono">CLOUDTALK_KEY_SECRET</span> for Production. Redeploy after saving them. The key form on this page only works on the local server.
          </p>
        </section>
      )}

      {source === "cloudtalk" && configured === false && host !== "vercel" && (
        <section className="max-w-lg rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="text-lg font-semibold">Connect CloudTalk</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Paste the Access Key ID and Access Key Secret from CloudTalk → Account → Settings → API keys. They stay in this folder’s <span className="mono">.credentials.json</span> file and are not sent to the browser again.
          </p>
          <label className="mt-4 block text-sm">
            Access Key ID
            <input
              value={keyId}
              onChange={(event) => setKeyId(event.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-[var(--line)] px-3 py-2"
            />
          </label>
          <label className="mt-3 block text-sm">
            Access Key Secret
            <input
              value={keySecret}
              onChange={(event) => setKeySecret(event.target.value)}
              type="password"
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-[var(--line)] px-3 py-2"
            />
          </label>
          <button
            type="button"
            onClick={() => void saveKey()}
            disabled={saving || !keyId.trim() || !keySecret.trim()}
            className="mt-4 rounded-md bg-[var(--teal)] px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save and load report"}
          </button>
        </section>
      )}

      {source === "cloudtalk" && report && (
        <div className="space-y-8">
          <section className="flex flex-wrap gap-2">
            {report.sources.map((item) => (
              <SourceChip key={item.id} source={item} />
            ))}
          </section>

          <section className="grid gap-3 md:grid-cols-3">
            {report.lines.map((line) => {
              const selected = lineId === line.id;
              return (
                <button
                  key={line.id}
                  type="button"
                  onClick={() => setLineId(selected ? "all" : line.id)}
                  className={`rounded-xl border px-4 py-3 text-left ${selected ? "border-[var(--teal)] bg-[var(--teal-soft)]" : "border-[var(--line)] bg-[var(--surface)]"}`}
                >
                  <p className="text-xs text-[var(--muted)]">Phone number</p>
                  <h2 className="mt-1 text-lg font-semibold">{line.name}</h2>
                  <p className="mono text-sm">{line.e164 || "—"}</p>
                  <p className="mt-2 text-sm">
                    {line.callsLoaded} loaded{line.callsTotal != null ? ` of ${line.callsTotal}` : ""} calls
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    {percent(line.answerRate)} answered · {duration(line.talkSeconds)} talk · {line.agents} agents
                  </p>
                  {line.error && <p className="mt-1 text-xs text-[var(--red)]">{line.error}</p>}
                </button>
              );
            })}
          </section>
          {lineId !== "all" && (
            <p className="text-sm text-[var(--muted)]">
              Showing {selectedLine?.name}. Click that number again to show all three.
            </p>
          )}

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Calls loaded" value={String(selectedLine ? selectedLine.callsLoaded : report.summary.callsLoaded)} hint={selectedLine ? (selectedLine.callsTotal != null ? `${selectedLine.callsTotal} on this number` : selectedLine.name) : report.summary.callsTotal != null ? `${report.summary.callsTotal} across the numbers` : "Range total unavailable"} />
            <Metric label="Answer rate" value={percent(selectedLine ? selectedLine.answerRate : report.summary.answerRate)} hint={selectedLine ? `${selectedLine.answered} answered · ${selectedLine.missed} missed` : `${report.summary.answered} answered · ${report.summary.missed} missed`} />
            <Metric label="Talk time" value={duration(selectedLine ? selectedLine.talkSeconds : report.summary.talkSeconds)} hint={selectedLine ? `${selectedLine.incoming} incoming · ${selectedLine.outgoing} outgoing` : report.summary.avgTalkSeconds == null ? "No answered calls" : `${duration(report.summary.avgTalkSeconds)} average`} />
            <Metric label="Agents" value={String(selectedLine ? selectedLine.agents : report.summary.agents)} hint={selectedLine ? selectedLine.e164 : `${report.summary.onlineAgents} online · ${report.summary.numbers} numbers`} />
          </section>

          {(selectedLine ? selectedLine.callsTotal != null && selectedLine.callsLoaded < selectedLine.callsTotal : report.summary.callsTruncated) && (
            <p className="rounded-lg bg-[var(--amber-soft)] px-3 py-2 text-sm text-[var(--amber)]">
              {selectedLine
                ? `Showing the latest ${selectedLine.callsLoaded} of ${selectedLine.callsTotal} calls on ${selectedLine.name}.`
                : `Showing the latest ${report.summary.callsLoaded} of ${report.summary.callsTotal} calls across the numbers.`}
            </p>
          )}

          <Chart title={selectedLine ? `Calls by day · ${selectedLine.name}` : "Calls by day"} buckets={daily} />

          <section>
            <h2 className="mb-2 text-lg font-semibold">Agents</h2>
            <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)]">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="text-xs text-[var(--muted)]">
                  <tr className="border-b border-[var(--line)]">
                    {["Agent", "Status", "Extension", "Calls", "Answered", "Missed", "Talk time"].map((heading) => (
                      <th key={heading} className="px-3 py-2 font-medium">{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleAgents.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-4 text-[var(--muted)]">No agents on this number.</td></tr>
                  )}
                  {visibleAgents.map((agent) => (
                    <tr key={agent.id || agent.email} className="border-b border-[var(--line)] last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-medium">{agent.name}</div>
                        <div className="text-xs text-[var(--muted)]">{agent.email || agent.defaultNumber || "—"}</div>
                      </td>
                      <td className="px-3 py-2">{titleCase(agent.availability)}</td>
                      <td className="px-3 py-2 mono">{agent.extension || "—"}</td>
                      <td className="px-3 py-2">{agent.calls}</td>
                      <td className="px-3 py-2">{agent.answered}</td>
                      <td className="px-3 py-2">{agent.missed}</td>
                      <td className="px-3 py-2">{duration(agent.talkSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs text-[var(--muted)]">Call counts are from the calls loaded for the selected dates.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold">Groups today</h2>
            <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)]">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="text-xs text-[var(--muted)]">
                  <tr className="border-b border-[var(--line)]">
                    {["Group", "Agents", "Answered", "Unanswered", "Abandon", "Avg wait", "Queue now"].map((heading) => (
                      <th key={heading} className="px-3 py-2 font-medium">{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.groupStats.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-4 text-[var(--muted)]">{report.sources.find((item) => item.id === "groupStats")?.error || "No live group statistics."}</td></tr>
                  )}
                  {report.groupStats.map((group) => (
                    <tr key={group.id || group.name} className="border-b border-[var(--line)] last:border-0">
                      <td className="px-3 py-2 font-medium">{group.name}</td>
                      <td className="px-3 py-2">{group.operators}</td>
                      <td className="px-3 py-2">{group.answered}</td>
                      <td className="px-3 py-2">{group.unanswered}</td>
                      <td className="px-3 py-2">{group.abandonRate == null ? "—" : `${group.abandonRate.toFixed(1)}%`}</td>
                      <td className="px-3 py-2">{group.avgWaitingSeconds == null ? "—" : duration(group.avgWaitingSeconds)}</td>
                      <td className="px-3 py-2">{group.queue ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.groups.length > 0 && (
              <p className="mt-2 text-sm text-[var(--muted)]">Account groups: {report.groups.map((group) => group.name).join(", ")}</p>
            )}
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
              <h2 className="text-lg font-semibold">{selectedLine ? `Calls · ${selectedLine.name}` : "Calls"}</h2>
              <div className="flex flex-wrap gap-2">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search agent, contact, number"
                  className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm"
                />
                <select value={direction} onChange={(event) => setDirection(event.target.value)} className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm">
                  <option value="all">All directions</option>
                  <option value="incoming">Incoming</option>
                  <option value="outgoing">Outgoing</option>
                  <option value="internal">Internal</option>
                </select>
                <select value={result} onChange={(event) => setResult(event.target.value)} className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm">
                  <option value="all">Answered and missed</option>
                  <option value="answered">Answered</option>
                  <option value="missed">Missed</option>
                </select>
                <button type="button" onClick={() => downloadCalls(filteredCalls)} className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm">
                  Download CSV
                </button>
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)]">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="text-xs text-[var(--muted)]">
                  <tr className="border-b border-[var(--line)]">
                    {["When", "Number", "Direction", "Result", "Agent", "Contact", "Caller", "Talk"].map((heading) => (
                      <th key={heading} className="px-3 py-2 font-medium">{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredCalls.length === 0 && (
                    <tr><td colSpan={8} className="px-3 py-4 text-[var(--muted)]">No calls match this view.</td></tr>
                  )}
                  {filteredCalls.slice(0, 200).map((call) => (
                    <tr key={`${call.id}-${call.startedAt}`} className="border-b border-[var(--line)] last:border-0">
                      <td className="px-3 py-2 whitespace-nowrap">{when(call.startedAt)}</td>
                      <td className="px-3 py-2">
                        <div>{call.lineName || "—"}</div>
                        <div className="mono text-xs text-[var(--muted)]">{call.internalNumber || "—"}</div>
                      </td>
                      <td className="px-3 py-2">{titleCase(call.direction)}</td>
                      <td className="px-3 py-2">
                        <span className={call.answered ? "text-[var(--teal)]" : "text-[var(--red)]"}>
                          {call.voicemail ? "Voicemail" : call.answered ? "Answered" : "Missed"}
                        </span>
                        {call.recorded ? <span className="ml-2 text-xs text-[var(--muted)]">recorded</span> : null}
                      </td>
                      <td className="px-3 py-2">{call.agentName}</td>
                      <td className="px-3 py-2">
                        <div>{call.contactName || "—"}</div>
                        <div className="text-xs text-[var(--muted)]">{call.company || call.tags.join(", ")}</div>
                      </td>
                      <td className="px-3 py-2 mono text-xs">{call.externalNumber || "—"}</td>
                      <td className="px-3 py-2">{duration(call.talkingSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredCalls.length > 200 && (
              <p className="mt-1 text-xs text-[var(--muted)]">Showing 200 of {filteredCalls.length} matching calls. Download the CSV for the full filtered list.</p>
            )}
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <SimpleTable
              title="Contacts"
              empty="No contacts returned."
              headers={["Name", "Company", "Numbers", "Email"]}
              rows={report.contacts.slice(0, 100).map((contact) => [
                contact.name,
                contact.company || contact.title || "—",
                contact.numbers.join(", ") || "—",
                contact.emails.join(", ") || "—",
              ])}
            />
            <SimpleTable
              title="Numbers"
              empty="No numbers returned."
              headers={["Name", "Number", "Route"]}
              rows={report.numbers.map((item) => [item.name, item.e164 || "—", item.redirected ? `${item.connectedTo} · redirected` : item.connectedTo])}
            />
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <SimpleTable
              title="Tags"
              empty="No tags returned."
              headers={["Tag"]}
              rows={report.tags.map((tag) => [tag.name])}
            />
            <SimpleTable
              title="Notes"
              empty={report.sources.find((item) => item.id === "notes")?.error || "No notes returned."}
              headers={["When", "Note"]}
              rows={report.notes.slice(0, 50).map((note) => [when(note.created), note.note])}
            />
          </section>

          <p className="text-xs text-[var(--muted)]">Fetched {when(report.fetchedAt)} for {report.range.from} to {report.range.to}.</p>
        </div>
      )}
    </main>
  );
};

const FrejunPanel = ({
  report,
  loading,
  error,
  lineId,
  onLine,
}: {
  report: FrejunReport | null;
  loading: boolean;
  error: string;
  lineId: string;
  onLine: (id: string) => void;
}) => {
  const line = report?.lines.find((item) => item.id === lineId) ?? null;
  const calls = (report?.calls ?? []).filter((call) => lineId === "all" || call.virtualNumber === lineId);
  const daily = useMemo(
    () => (report ? bucketsFor(calls.map((call) => ({ startedAt: call.startedAt, answered: call.answered, talkingSeconds: call.durationSeconds })), report.range.from, report.range.to) : []),
    [calls, report],
  );
  const agents = useMemo(() => {
    if (!report || lineId === "all") return report?.agents ?? [];
    const map = new Map<string, { name: string; calls: number; answered: number; missed: number; talkSeconds: number }>();
    for (const call of calls) {
      const row = map.get(call.agentName) ?? { name: call.agentName, calls: 0, answered: 0, missed: 0, talkSeconds: 0 };
      row.calls += 1;
      row.talkSeconds += call.durationSeconds;
      if (call.answered) row.answered += 1;
      else row.missed += 1;
      map.set(call.agentName, row);
    }
    return [...map.values()].sort((a, b) => b.calls - a.calls);
  }, [report, lineId, calls]);

  if (loading && !report) return <p className="text-sm text-[var(--muted)]">Loading Frejun…</p>;
  if (error) return <p className="rounded-lg border border-[#efc8c4] bg-[var(--red-soft)] px-3 py-2 text-sm text-[var(--red)]">{error}</p>;
  if (!report) return null;

  const summary = line
    ? { calls: line.calls, total: line.calls, answered: line.answered, missed: line.missed, talk: line.talkSeconds, rate: line.answerRate, agents: line.agents, incoming: line.incoming, outgoing: line.outgoing }
    : { calls: report.summary.callsLoaded, total: report.summary.callsTotal, answered: report.summary.answered, missed: report.summary.missed, talk: report.summary.talkSeconds, rate: report.summary.answerRate, agents: report.summary.agents, incoming: report.summary.incoming, outgoing: report.summary.outgoing };

  return (
    <div className="space-y-8">
      <section className="grid gap-3 md:grid-cols-3">
        {report.lines.map((item) => {
          const selected = lineId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onLine(selected ? "all" : item.id)}
              className={`rounded-xl border px-4 py-3 text-left ${selected ? "border-[var(--teal)] bg-[var(--teal-soft)]" : "border-[var(--line)] bg-[var(--surface)]"}`}
            >
              <p className="text-xs text-[var(--muted)]">Virtual number</p>
              <h2 className="mt-1 text-lg font-semibold">{item.e164}</h2>
              <p className="mt-2 text-sm">{item.calls} calls</p>
              <p className="text-xs text-[var(--muted)]">{percent(item.answerRate)} answered · {duration(item.talkSeconds)} talk · {item.agents} users</p>
            </button>
          );
        })}
      </section>
      {line && <p className="text-sm text-[var(--muted)]">Showing {line.e164}. Click that number again to show every Frejun number.</p>}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Calls loaded" value={String(summary.calls)} hint={summary.total != null ? `${summary.total} in this range` : "Range total unavailable"} />
        <Metric label="Answer rate" value={percent(summary.rate)} hint={`${summary.answered} answered · ${summary.missed} missed`} />
        <Metric label="Talk time" value={duration(summary.talk)} hint={`${summary.incoming} incoming · ${summary.outgoing} outgoing`} />
        <Metric label="Users" value={String(summary.agents)} hint={`${report.summary.numbers} virtual numbers`} />
      </section>
      {report.summary.callsTruncated && !line && (
        <p className="rounded-lg bg-[var(--amber-soft)] px-3 py-2 text-sm text-[var(--amber)]">
          Showing the latest {report.summary.callsLoaded} of {report.summary.callsTotal} Frejun calls.
        </p>
      )}
      <Chart title={line ? `Calls by day · ${line.e164}` : "Calls by day"} buckets={daily} />
      <section>
        <h2 className="mb-2 text-lg font-semibold">Users</h2>
        <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)]">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[var(--muted)]">
              <tr className="border-b border-[var(--line)]">
                {["User", "Calls", "Answered", "Missed", "Talk time"].map((heading) => (
                  <th key={heading} className="px-3 py-2 font-medium">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-[var(--muted)]">No users on these calls.</td></tr>}
              {agents.map((agent) => (
                <tr key={agent.name} className="border-b border-[var(--line)] last:border-0">
                  <td className="px-3 py-2">{agent.name}</td>
                  <td className="px-3 py-2">{agent.calls}</td>
                  <td className="px-3 py-2">{agent.answered}</td>
                  <td className="px-3 py-2">{agent.missed}</td>
                  <td className="px-3 py-2">{duration(agent.talkSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-lg font-semibold">{line ? `Calls · ${line.e164}` : "Calls"}</h2>
        <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)]">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="text-xs text-[var(--muted)]">
              <tr className="border-b border-[var(--line)]">
                {["When", "Number", "Direction", "Status", "User", "Contact", "Talk"].map((heading) => (
                  <th key={heading} className="px-3 py-2 font-medium">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calls.length === 0 && <tr><td colSpan={7} className="px-3 py-4 text-[var(--muted)]">No calls in this range.</td></tr>}
              {calls.slice(0, 200).map((call) => (
                <tr key={call.id} className="border-b border-[var(--line)] last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap">{when(call.startedAt)}</td>
                  <td className="px-3 py-2 mono text-xs">{call.virtualNumber || "—"}</td>
                  <td className="px-3 py-2">{titleCase(call.direction)}</td>
                  <td className={`px-3 py-2 ${call.answered ? "text-[var(--teal)]" : "text-[var(--red)]"}`}>{titleCase(call.status.replaceAll("-", " "))}</td>
                  <td className="px-3 py-2">{call.agentName}</td>
                  <td className="px-3 py-2">
                    <div>{call.contactName || "—"}</div>
                    <div className="mono text-xs text-[var(--muted)]">{call.externalNumber}</div>
                  </td>
                  <td className="px-3 py-2">{duration(call.durationSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {calls.length > 200 && <p className="mt-1 text-xs text-[var(--muted)]">Showing 200 of {calls.length} calls.</p>}
      </section>
    </div>
  );
};

const SourceChip = ({ source }: { source: SourceStatus }) => (
  <span
    className={`rounded-full px-2.5 py-1 text-xs ${source.ok ? "bg-[var(--teal-soft)] text-[var(--teal)]" : "bg-[var(--red-soft)] text-[var(--red)]"}`}
    title={source.error || ""}
  >
    {source.label}: {source.ok ? source.fetched : source.error}
  </span>
);

const Metric = ({ label, value, hint }: { label: string; value: string; hint: string }) => (
  <article className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
    <p className="text-xs text-[var(--muted)]">{label}</p>
    <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
    <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>
  </article>
);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const axisLabel = (bucket: Bucket) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bucket.key);
  if (!match) return bucket.label;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
};

const Chart = ({ title, buckets }: { title: string; buckets: Bucket[] }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const update = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setContainerWidth((prev) => (prev === w ? prev : w));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!buckets || buckets.length === 0) {
    return (
      <article className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">No calls in this range.</p>
      </article>
    );
  }

  const peak = Math.max(1, ...buckets.map((bucket) => bucket.calls));
  const total = buckets.reduce((sum, bucket) => sum + bucket.calls, 0);
  const busiest = buckets.reduce((best, bucket) => (bucket.calls > best.calls ? bucket : best), buckets[0]);

  const plotH = 160;
  const top = 26;
  const labelH = 56;
  const padLeft = 40;
  const padRight = 16;
  const height = top + plotH + labelH;
  const baselineY = top + plotH;

  const availableWidth = containerWidth > 0 ? containerWidth : 700;
  const minSlotW = 28;
  const minChartWidth = padLeft + padRight + buckets.length * minSlotW;
  const chartWidth = Math.max(availableWidth, minChartWidth);
  const usableWidth = chartWidth - padLeft - padRight;
  const slotWidth = usableWidth / buckets.length;
  const barW = Math.max(8, Math.min(32, slotWidth * 0.55));
  const isRotated = slotWidth < 55;

  return (
    <article className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {total > 0 && busiest && (
          <p className="text-xs text-[var(--muted)]">
            {total} calls · busiest {axisLabel(busiest)} ({busiest.calls} calls)
          </p>
        )}
      </div>
      {total === 0 ? (
        <p className="text-sm text-[var(--muted)]">No calls in this range.</p>
      ) : (
        <div ref={containerRef} className="w-full overflow-x-auto">
          <svg
            width={chartWidth}
            height={height}
            viewBox={`0 0 ${chartWidth} ${height}`}
            role="img"
            aria-label={title}
            className="block"
            style={{
              width: chartWidth > availableWidth ? `${chartWidth}px` : "100%",
              height: `${height}px`,
              minHeight: `${height}px`,
            }}
          >
            {/* Top peak grid line & label */}
            <line
              x1={padLeft}
              y1={top}
              x2={chartWidth - padRight}
              y2={top}
              stroke="#ece7df"
              strokeDasharray="3 3"
            />
            <text
              x={padLeft - 8}
              y={top + 4}
              textAnchor="end"
              fill="#5e6a64"
              fontSize="11"
              fontFamily="inherit"
            >
              {peak}
            </text>

            {/* Mid grid line & label if peak > 1 */}
            {peak > 1 && (
              <>
                <line
                  x1={padLeft}
                  y1={top + plotH / 2}
                  x2={chartWidth - padRight}
                  y2={top + plotH / 2}
                  stroke="#f2eee7"
                  strokeDasharray="3 3"
                />
                <text
                  x={padLeft - 8}
                  y={top + plotH / 2 + 4}
                  textAnchor="end"
                  fill="#8c9791"
                  fontSize="10"
                  fontFamily="inherit"
                >
                  {Math.round(peak / 2)}
                </text>
              </>
            )}

            {/* Baseline & 0 label */}
            <line
              x1={padLeft}
              y1={baselineY}
              x2={chartWidth - padRight}
              y2={baselineY}
              stroke="#e2dbd0"
            />
            <text
              x={padLeft - 8}
              y={baselineY + 3}
              textAnchor="end"
              fill="#8c9791"
              fontSize="10"
              fontFamily="inherit"
            >
              0
            </text>

            {/* Bars and labels */}
            {buckets.map((bucket, index) => {
              const barH = bucket.calls === 0 ? 0 : Math.max(4, (bucket.calls / peak) * (plotH - 8));
              const centerX = padLeft + (index + 0.5) * slotWidth;
              const x = centerX - barW / 2;
              const y = baselineY - barH;
              const label = axisLabel(bucket);

              return (
                <g key={bucket.key}>
                  <title>{`${label}: ${bucket.calls} calls`}</title>
                  {bucket.calls > 0 && (
                    <text
                      x={centerX}
                      y={y - 5}
                      textAnchor="middle"
                      fill="#1b2421"
                      fontSize="11"
                      fontWeight="600"
                      fontFamily="inherit"
                    >
                      {bucket.calls}
                    </text>
                  )}
                  <rect
                    x={x}
                    y={y}
                    width={barW}
                    height={barH}
                    rx="3"
                    fill={bucket.calls ? "#0f6e62" : "transparent"}
                  />
                  {isRotated ? (
                    <text
                      x={centerX}
                      y={baselineY + 10}
                      textAnchor="start"
                      fill="#5e6a64"
                      fontSize="11"
                      fontFamily="inherit"
                      transform={`rotate(55 ${centerX} ${baselineY + 10})`}
                    >
                      {label}
                    </text>
                  ) : (
                    <text
                      x={centerX}
                      y={baselineY + 18}
                      textAnchor="middle"
                      fill="#5e6a64"
                      fontSize="11"
                      fontFamily="inherit"
                    >
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </article>
  );
};

const SimpleTable = ({ title, headers, rows, empty }: { title: string; headers: string[]; rows: string[][]; empty: string }) => (
  <article>
    <h2 className="mb-2 text-lg font-semibold">{title}</h2>
    <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)]">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-[var(--muted)]">
          <tr className="border-b border-[var(--line)]">
            {headers.map((heading) => (
              <th key={heading} className="px-3 py-2 font-medium">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={headers.length} className="px-3 py-4 text-[var(--muted)]">{empty}</td></tr>
          )}
          {rows.map((row, index) => (
            <tr key={`${title}-${index}`} className="border-b border-[var(--line)] last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="max-w-xs px-3 py-2 align-top break-words">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </article>
);
