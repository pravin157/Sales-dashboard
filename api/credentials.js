// src/http.ts
import "dotenv/config";

// src/cloudtalk.ts
import fs from "fs";
import path from "path";
var BASE = "https://my.cloudtalk.io/api";
var CREDENTIALS_FILE = path.join(process.cwd(), ".credentials.json");
var PAGE_LIMIT = 100;
var MAX_CALL_PAGES = 20;
var MIN_GAP_MS = 1200;
var REPORT_TTL_MS = 5 * 6e4;
var DIRECTORY_TTL_MS = 10 * 6e4;
var requestQueue = Promise.resolve();
var lastRequestAt = 0;
var pace = () => {
  const turn = requestQueue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  requestQueue = turn.then(
    () => void 0,
    () => void 0
  );
  return turn;
};
var credentialsConfigured = () => {
  const id = (process.env.CLOUDTALK_KEY_ID || "").trim();
  const secret = (process.env.CLOUDTALK_KEY_SECRET || "").trim();
  return Boolean(id && secret);
};
var loadStoredCredentials = () => {
  if (credentialsConfigured() || !fs.existsSync(CREDENTIALS_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
    const id = (parsed.keyId || "").trim();
    const secret = (parsed.keySecret || "").trim();
    if (id && secret) {
      process.env.CLOUDTALK_KEY_ID = id;
      process.env.CLOUDTALK_KEY_SECRET = secret;
    }
  } catch {
  }
};
var saveCredentials = (keyId, keySecret) => {
  const id = keyId.trim();
  const secret = keySecret.trim();
  if (!id || !secret) throw new Error("Both the Access Key ID and the Access Key Secret are required.");
  if (id.length > 200 || secret.length > 200) throw new Error("Those credentials look too long.");
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ keyId: id, keySecret: secret }), {
    encoding: "utf8",
    mode: 384
  });
  process.env.CLOUDTALK_KEY_ID = id;
  process.env.CLOUDTALK_KEY_SECRET = secret;
};
loadStoredCredentials();
var authHeader = () => {
  const id = (process.env.CLOUDTALK_KEY_ID || "").trim();
  const secret = (process.env.CLOUDTALK_KEY_SECRET || "").trim();
  if (!id || !secret) return null;
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
};
var asRecord = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
var asArray = (value) => Array.isArray(value) ? value : [];
var text = (value) => {
  if (value == null) return "";
  return String(value).trim();
};
var num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
var phone = (value) => {
  const raw = text(value).replace(/\s+/g, "");
  if (!raw) return "";
  return raw.startsWith("+") ? raw : `+${raw}`;
};
var personName = (row) => {
  const joined = [text(row.firstname) || text(row.first_name), text(row.lastname) || text(row.last_name)].filter(Boolean).join(" ").trim();
  return joined || text(row.fullname) || text(row.name) || text(row.email) || "Unknown";
};
var unwrap = (row, key) => {
  const record = asRecord(row);
  const nested = asRecord(record[key]);
  return Object.keys(nested).length ? nested : record;
};
var stringList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string" || typeof item === "number") return text(item);
      const record = asRecord(item);
      return text(record.public_number) || text(record.number) || text(record.email) || text(record.name) || text(record.label);
    }).filter(Boolean);
  }
  const single = text(value);
  return single ? [single] : [];
};
var messageFrom = (json2, status) => {
  const root = asRecord(json2);
  const data = asRecord(root.responseData ?? root);
  const msg = text(data.message) || text(root.message) || text(root.error);
  if (status === 401 || status === 403) return msg || `CloudTalk rejected the key (${status}).`;
  if (status >= 400) return msg || `CloudTalk returned ${status}.`;
  if (data.status && Number(data.status) >= 400 && !Array.isArray(data.data)) {
    return msg || `CloudTalk returned status ${data.status}.`;
  }
  return void 0;
};
var getPage = async (pathname, query = {}, attempt = 0) => {
  const auth = authHeader();
  if (!auth) {
    return { status: 0, items: [], itemsCount: 0, pageCount: 0, message: "API key is not set.", raw: null };
  }
  await pace();
  const url = new URL(`${BASE}${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== void 0 && value !== "") url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
  if (res.status === 429 && attempt < 3) {
    await new Promise((resolve) => setTimeout(resolve, 8e3 * (attempt + 1)));
    return getPage(pathname, query, attempt + 1);
  }
  const body = await res.text();
  let json2 = null;
  try {
    json2 = body ? JSON.parse(body) : null;
  } catch {
    json2 = { message: body.slice(0, 240) };
  }
  const root = asRecord(json2);
  const data = asRecord(root.responseData ?? root);
  const items = Array.isArray(data.data) ? data.data : Array.isArray(root.data) ? root.data : [];
  const message = messageFrom(json2, res.status);
  return {
    status: res.status,
    items: message && res.status >= 400 ? [] : items,
    itemsCount: num(data.itemsCount ?? items.length),
    pageCount: Math.max(num(data.pageCount) || (items.length ? 1 : 0), 0),
    message: res.ok ? void 0 : message,
    raw: json2
  };
};
var fetchPages = async (pathname, query, maxPages) => {
  const first = await getPage(pathname, { ...query, limit: PAGE_LIMIT, page: 1 });
  if (first.message) return { items: [], total: null, error: first.message };
  const items = [...first.items];
  const pageCount = Math.min(first.pageCount || 1, maxPages);
  for (let page = 2; page <= pageCount; page += 1) {
    const next = await getPage(pathname, { ...query, limit: PAGE_LIMIT, page });
    if (next.message) return { items, total: first.itemsCount || items.length, error: next.message };
    items.push(...next.items);
    if (!next.items.length) break;
  }
  const total = first.itemsCount || items.length;
  return { items, total };
};
var stamp = (day, end) => `${day} ${end ? "23:59:59" : "00:00:00"}`;
var isoDay = (value) => {
  if (!value) return null;
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
var connectedLabel = (value) => {
  const code = text(value);
  if (code === "0") return "Group";
  if (code === "1") return "Agent";
  if (code === "2") return "Conference";
  if (code === "3") return "Fax";
  if (code === "4") return "Call flow";
  return code || "\u2014";
};
var mapCall = (row, agents) => {
  const record = asRecord(row);
  const cdr = unwrap(record.Cdr ?? record.Call ?? record, "Cdr");
  const agent = unwrap(record.Agent, "Agent");
  const contact = unwrap(record.Contact, "Contact");
  const callNumber = unwrap(record.CallNumber, "CallNumber");
  const agentId = text(cdr.user_id) || text(agent.id);
  const tags = [
    ...asArray(record.Tags).map((tag) => text(asRecord(tag).name) || text(unwrap(tag, "Tag").name)),
    ...asArray(cdr.call_tags).map((tag) => text(asRecord(tag).label) || text(asRecord(tag).name)),
    ...asArray(record.CallTags).map((tag) => text(unwrap(tag, "CallTag").name))
  ].filter(Boolean);
  const talking = num(cdr.talking_time);
  const answered = Boolean(text(cdr.answered_at)) || talking > 0;
  const recording = text(cdr.recording_link);
  return {
    id: text(cdr.id) || text(cdr.cdr_id),
    startedAt: text(cdr.started_at) || text(cdr.date) || null,
    endedAt: text(cdr.ended_at) || null,
    direction: text(cdr.type) || text(cdr.direction) || "unknown",
    answered,
    voicemail: Boolean(cdr.is_voicemail),
    recorded: Boolean(cdr.recorded),
    externalNumber: phone(cdr.public_external) || phone(asRecord(cdr.contact).number),
    internalNumber: phone(cdr.public_internal) || phone(callNumber.caller_id_e164),
    internalName: text(callNumber.internal_name),
    agentId,
    agentName: personName(agent) !== "Unknown" ? personName(agent) : agents.get(agentId) || (agentId ? `Agent ${agentId}` : "Unassigned"),
    contactId: text(contact.id),
    contactName: text(contact.name),
    company: text(contact.company),
    talkingSeconds: talking,
    waitingSeconds: num(cdr.waiting_time),
    billSeconds: num(cdr.billsec),
    tags: [...new Set(tags)],
    recordingLink: recording.startsWith("http") ? recording : "",
    lineId: "",
    lineName: ""
  };
};
var mapAgent = (row) => {
  const agent = unwrap(row, "Agent");
  const outbound = agent.status_outbound;
  return {
    id: text(agent.id),
    name: personName(agent),
    email: text(agent.email),
    extension: text(agent.extension),
    availability: text(agent.availability_status) || "unknown",
    outboundEnabled: typeof outbound === "boolean" ? outbound : outbound == null ? null : Boolean(outbound),
    defaultNumber: phone(agent.default_number),
    associatedNumbers: stringList(agent.associated_numbers).map((item) => phone(item)),
    calls: 0,
    answered: 0,
    missed: 0,
    talkSeconds: 0,
    lineIds: []
  };
};
var mapContact = (row) => {
  const record = asRecord(row);
  const contact = unwrap(record.Contact ?? record, "Contact");
  const emails = [
    ...stringList(contact.contact_emails),
    ...stringList(record.ContactEmail ? [unwrap(record.ContactEmail, "ContactEmail").email] : []),
    text(unwrap(record.ContactEmail, "ContactEmail").email)
  ].filter(Boolean);
  const numbers = [
    ...stringList(contact.contact_numbers),
    phone(unwrap(record.ContactNumber, "ContactNumber").public_number)
  ].map((item) => phone(item)).filter(Boolean);
  const tags = [
    ...asArray(contact.tags).map((tag) => text(asRecord(tag).name)),
    ...asArray(record.Tags).map((tag) => text(unwrap(tag, "Tag").name) || text(asRecord(tag).name))
  ].filter(Boolean);
  return {
    id: text(contact.id),
    name: text(contact.name) || "Unnamed contact",
    company: text(contact.company),
    title: text(contact.title),
    industry: text(contact.industry),
    emails: [...new Set(emails)],
    numbers: [...new Set(numbers)],
    tags: [...new Set(tags)],
    type: text(contact.type)
  };
};
var mapNumber = (row) => {
  const item = unwrap(row, "CallNumber");
  return {
    id: text(item.id),
    name: text(item.internal_name) || "Untitled number",
    e164: phone(item.caller_id_e164),
    countryCode: text(item.country_code),
    areaCode: text(item.area_code),
    connectedTo: connectedLabel(item.connected_to),
    redirected: Boolean(item.is_redirected)
  };
};
var mapGroup = (row) => {
  const item = unwrap(row, "Group");
  return { id: text(item.id), name: text(item.internal_name) || text(item.name) || "Untitled group" };
};
var mapTag = (row) => {
  const item = unwrap(row, "Tag");
  return { id: text(item.id), name: text(item.name) || text(item.label) || "Untitled tag" };
};
var mapNote = (row) => {
  const item = unwrap(row, "ContactNote");
  return {
    id: text(item.id),
    contactId: text(item.contact_id),
    userId: text(item.user_id),
    note: text(item.note),
    created: text(item.created) || null
  };
};
var eachDay = (from, to) => {
  const days = [];
  const cursor = /* @__PURE__ */ new Date(`${from}T00:00:00`);
  const end = /* @__PURE__ */ new Date(`${to}T00:00:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return days;
  while (cursor <= end && days.length < 370) {
    const pad = (n) => String(n).padStart(2, "0");
    days.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
};
var fillBuckets = (keys, calls) => {
  const map = new Map(
    keys.map((item) => [item.key, { ...item, calls: 0, answered: 0, missed: 0, talkSeconds: 0 }])
  );
  for (const call of calls) {
    const bucket = map.get(isoDay(call.startedAt) || "");
    if (!bucket) continue;
    bucket.calls += 1;
    bucket.talkSeconds += call.talkingSeconds;
    if (call.answered) bucket.answered += 1;
    else bucket.missed += 1;
  }
  return [...map.values()];
};
var source = (id, label, fetched, total, error) => ({
  id,
  label,
  ok: !error,
  fetched,
  total,
  error
});
var digits = (value) => value.replace(/\D/g, "");
var sameLine = (left, right) => {
  const a = digits(left);
  const b = digits(right);
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
};
var summarizeLine = (number, rows, total, error) => {
  const answered = rows.filter((call) => call.answered).length;
  const talkSeconds = rows.reduce((sum, call) => sum + call.talkingSeconds, 0);
  return {
    id: number.id,
    name: number.name,
    e164: number.e164,
    connectedTo: number.connectedTo,
    callsLoaded: rows.length,
    callsTotal: total,
    answered,
    missed: rows.length - answered,
    incoming: rows.filter((call) => call.direction === "incoming").length,
    outgoing: rows.filter((call) => call.direction === "outgoing").length,
    internal: rows.filter((call) => call.direction === "internal").length,
    talkSeconds,
    answerRate: rows.length ? answered / rows.length : null,
    agents: new Set(rows.map((call) => call.agentId).filter(Boolean)).size,
    error
  };
};
var buildReport = (from, to, window = null) => {
  const key = `${from}|${to}|${window?.start ?? ""}|${window?.end ?? ""}`;
  const cached = reportCache.get(key);
  if (cached && Date.now() - cached.at < REPORT_TTL_MS) return Promise.resolve(cached.report);
  const pending = reportInflight.get(key);
  if (pending) return pending;
  const run = buildReportUncached(from, to, window).then((report) => {
    reportCache.set(key, { at: Date.now(), report });
    reportInflight.delete(key);
    return report;
  }).catch((err) => {
    reportInflight.delete(key);
    throw err;
  });
  reportInflight.set(key, run);
  return run;
};
var reportCache = /* @__PURE__ */ new Map();
var reportInflight = /* @__PURE__ */ new Map();
var directoryCache = null;
var directoryInflight = null;
var loadDirectory = () => {
  if (directoryCache && Date.now() - directoryCache.at < DIRECTORY_TTL_MS) return Promise.resolve(directoryCache.directory);
  if (directoryInflight) return directoryInflight;
  const run = Promise.all([
    fetchPages("/agents/index.json", {}, 5),
    fetchPages("/numbers/index.json", {}, 5),
    fetchPages("/groups/index.json", {}, 5),
    fetchPages("/tags/index.json", {}, 5),
    fetchPages("/contacts/index.json", {}, 5),
    fetchPages("/notes/index.json", {}, 3)
  ]).then(([agentsPage, numbersPage, groupsPage, tagsPage, contactsPage, notesPage]) => {
    const directory = { agentsPage, numbersPage, groupsPage, tagsPage, contactsPage, notesPage };
    const failed = Object.values(directory).some((page) => page.error);
    directoryCache = failed ? null : { at: Date.now(), directory };
    return directory;
  }).finally(() => {
    directoryInflight = null;
  });
  directoryInflight = run;
  return run;
};
var callsCache = [];
var loadCalls = async (from, to) => {
  const now = Date.now();
  const cover = callsCache.find((entry) => now - entry.at < REPORT_TTL_MS && entry.from <= from && entry.to >= to);
  if (cover) {
    const items = cover.items.filter((row) => {
      const day = isoDay(mapCall(row, /* @__PURE__ */ new Map()).startedAt);
      return day != null && day >= from && day <= to;
    });
    return { items, total: items.length };
  }
  const page = await fetchPages("/calls/index.json", { date_from: stamp(from, false), date_to: stamp(to, true) }, MAX_CALL_PAGES);
  if (!page.error && page.items.length >= (page.total ?? 0)) {
    callsCache.unshift({ from, to, at: now, items: page.items });
    callsCache.length = Math.min(callsCache.length, 5);
  }
  return page;
};
var shiftDay = (day, by) => {
  const date = /* @__PURE__ */ new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + by);
  return isoDay(date.toISOString()) || day;
};
var buildReportUncached = async (from, to, window) => {
  const start = window ? Date.parse(window.start) : NaN;
  const end = window ? Date.parse(window.end) : NaN;
  const timed = Number.isFinite(start) && Number.isFinite(end);
  const [directory, callsPage, statsPage] = await Promise.all([
    loadDirectory(),
    timed ? loadCalls(shiftDay(from, -1), shiftDay(to, 1)) : loadCalls(from, to),
    getPage("/statistics/realtime/groups.json")
  ]);
  const { agentsPage, numbersPage, groupsPage, tagsPage, contactsPage, notesPage } = directory;
  const agents = agentsPage.items.map(mapAgent).filter((agent) => agent.id || agent.name);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const numbers = numbersPage.items.map(mapNumber);
  const calls = [];
  const seen = /* @__PURE__ */ new Set();
  const callsError = callsPage.error;
  const downloadComplete = !callsError && callsPage.items.length >= (callsPage.total ?? 0);
  for (const row of callsPage.items) {
    const call = mapCall(row, agentNames);
    if (!call.id && !call.startedAt) continue;
    if (timed) {
      const at = Date.parse(call.startedAt || "");
      if (!Number.isFinite(at) || at < start || at > end) continue;
    }
    if (call.id && seen.has(call.id)) continue;
    if (call.id) seen.add(call.id);
    const line = numbers.find((number) => sameLine(call.internalNumber, number.e164));
    if (line) {
      call.lineId = line.id;
      call.lineName = line.name || line.e164;
    }
    calls.push(call);
  }
  const callsTotal = downloadComplete ? calls.length : callsPage.total ?? 0;
  const complete = downloadComplete;
  const lines = numbers.map((number) => {
    const rows = calls.filter((call) => call.lineId === number.id);
    return summarizeLine(number, rows, complete ? rows.length : null, callsError);
  });
  calls.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  for (const agent of agents) {
    const matched = numbers.filter(
      (number) => sameLine(agent.defaultNumber, number.e164) || agent.associatedNumbers.some((value) => sameLine(value, number.e164))
    );
    agent.lineIds = matched.map((number) => number.id);
  }
  for (const call of calls) {
    const agent = agents.find((item) => item.id === call.agentId);
    if (!agent) continue;
    if (call.lineId && !agent.lineIds.includes(call.lineId)) agent.lineIds.push(call.lineId);
    agent.calls += 1;
    agent.talkSeconds += call.talkingSeconds;
    if (call.answered) agent.answered += 1;
    else agent.missed += 1;
  }
  agents.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const contacts = contactsPage.items.map(mapContact);
  const groups = groupsPage.items.map(mapGroup);
  const tags = tagsPage.items.map(mapTag).filter((tag) => tag.name);
  const notes = notesPage.items.map(mapNote).filter((note) => note.note);
  const statsRoot = asRecord(asRecord(statsPage.raw).responseData);
  const statsData = asRecord(statsRoot.data);
  const statGroups = asArray(statsData.groups).length ? asArray(statsData.groups) : asArray(statsRoot.groups);
  const groupStats = statsPage.message ? [] : statGroups.map((row) => {
    const item = asRecord(row);
    const realtime = asRecord(item.real_time);
    return {
      id: text(item.id),
      name: text(item.name) || "Group",
      operators: num(item.operators),
      answered: num(item.answered),
      unanswered: num(item.unanswered),
      abandonRate: item.abandon_rate == null ? null : num(item.abandon_rate),
      avgWaitingSeconds: item.avg_waiting_time == null ? null : num(item.avg_waiting_time),
      avgCallSeconds: item.avg_call_duration == null ? null : num(item.avg_call_duration),
      queue: realtime.waiting_queue == null ? null : num(realtime.waiting_queue)
    };
  });
  const answered = calls.filter((call) => call.answered).length;
  const missed = calls.length - answered;
  const talkSeconds = calls.reduce((sum, call) => sum + call.talkingSeconds, 0);
  const onlineAgents = agents.filter((agent) => agent.availability.toLowerCase() === "online").length;
  const callError = calls.length === 0 ? callsError : void 0;
  const sources = [
    source("calls", "Calls", calls.length, callsTotal || null, callError),
    source("agents", "Agents", agents.length, agentsPage.total, agentsPage.error),
    source("contacts", "Contacts", contacts.length, contactsPage.total, contactsPage.error),
    source("numbers", "Numbers", numbers.length, numbersPage.total, numbersPage.error),
    source("groups", "Groups", groups.length, groupsPage.total, groupsPage.error),
    source("tags", "Tags", tags.length, tagsPage.total, tagsPage.error),
    source("notes", "Notes", notes.length, notesPage.total, notesPage.error),
    source(
      "groupStats",
      "Live group stats",
      groupStats.length,
      groupStats.length || null,
      statsPage.message
    )
  ];
  return {
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
    range: { from, to },
    sources,
    summary: {
      callsLoaded: calls.length,
      callsTotal,
      callsTruncated: callsTotal != null && calls.length < callsTotal,
      answered,
      missed,
      incoming: calls.filter((call) => call.direction === "incoming").length,
      outgoing: calls.filter((call) => call.direction === "outgoing").length,
      internal: calls.filter((call) => call.direction === "internal").length,
      voicemail: calls.filter((call) => call.voicemail).length,
      recorded: calls.filter((call) => call.recorded).length,
      talkSeconds,
      waitingSeconds: calls.reduce((sum, call) => sum + call.waitingSeconds, 0),
      answerRate: calls.length ? answered / calls.length : null,
      avgTalkSeconds: answered ? talkSeconds / answered : null,
      agents: agents.length,
      onlineAgents,
      contactsLoaded: contacts.length,
      contactsTotal: contactsPage.total,
      numbers: numbers.length,
      groups: groups.length,
      tags: tags.length,
      notesLoaded: notes.length,
      notesTotal: notesPage.total
    },
    daily: fillBuckets(
      eachDay(from, to).map((day) => ({ key: day, label: day.slice(5) })),
      calls
    ),
    lines,
    calls,
    agents,
    contacts,
    numbers,
    groups,
    groupStats,
    tags,
    notes
  };
};

// src/frejun.ts
var PAGE_SIZE = 100;
var MAX_PAGES = 8;
var frejunConfigured = () => Boolean((process.env.FREJUN_API_KEY || "").trim());
var asRecord2 = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
var text2 = (value) => value == null ? "" : String(value).trim();
var num2 = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
var phone2 = (value) => {
  const raw = text2(value).replace(/\s+/g, "");
  if (!raw) return "";
  return raw.startsWith("+") ? raw : `+${raw}`;
};
var baseUrl = () => (process.env.FREJUN_API_BASE || "https://api.frejun.com").trim().replace(/\/+$/, "");
var frejunStamp = (day, time, end) => {
  const [year, month, date] = day.split("-");
  return `${date}/${month}/${year.slice(2)} ${time}:${end ? "59" : "00"}`;
};
var answeredStatus = (status, durationSeconds) => status === "answered" || durationSeconds > 0 && !status.includes("not-answered") && !status.includes("not-initiated");
var eachDay2 = (from, to) => {
  const days = [];
  const cursor = /* @__PURE__ */ new Date(`${from}T00:00:00`);
  const end = /* @__PURE__ */ new Date(`${to}T00:00:00`);
  while (cursor <= end && days.length < 370) {
    const pad = (n) => String(n).padStart(2, "0");
    days.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
};
var dayKey = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
var mapCall2 = (row) => {
  const status = text2(row.status) || "unknown";
  const minutes = num2(row.call_duration);
  const durationSeconds = Math.round(minutes * 60);
  const virtualNumber = phone2(row.virtual_number);
  return {
    id: text2(row.call_id) || text2(row.id),
    startedAt: text2(row.call_start_time) || null,
    direction: text2(row.call_type) || "unknown",
    status,
    answered: answeredStatus(status, durationSeconds),
    virtualNumber,
    externalNumber: phone2(row.candidate_number),
    contactName: text2(row.candidate_name),
    agentName: text2(row.recruiter) || "Unassigned",
    durationSeconds,
    outcome: text2(row.call_outcome),
    reason: text2(row.call_reason),
    notes: text2(row.recruiter_notes)
  };
};
var fetchJson = async (url) => {
  const key = (process.env.FREJUN_API_KEY || "").trim();
  const res = await fetch(url, { headers: { Authorization: `Api-Key ${key}`, Accept: "application/json" } });
  const body = await res.text();
  let json2 = null;
  try {
    json2 = body ? JSON.parse(body) : null;
  } catch {
    json2 = { message: body.slice(0, 240) };
  }
  return { status: res.status, json: asRecord2(json2) };
};
var buildFrejunReport = async (from, to, fromTime = "00:00", toTime = "23:59") => {
  if (!frejunConfigured()) throw new Error("Add FREJUN_API_KEY to .env, then refresh.");
  const params = new URLSearchParams({
    page_size: String(PAGE_SIZE),
    date: frejunStamp(from, fromTime, false),
    date_end: frejunStamp(to, toTime, true)
  });
  let nextUrl = `${baseUrl()}/api/v1/integrations/calls/?${params}`;
  const calls = [];
  let total = null;
  let pages = 0;
  while (nextUrl && pages < MAX_PAGES) {
    const { status, json: json2 } = await fetchJson(nextUrl);
    if (status === 429) throw new Error("Frejun rate limit exceeded. Wait a minute and refresh.");
    if (status >= 400 || json2.success === false) {
      const detail = asRecord2(json2.message);
      const message = typeof json2.message === "string" ? json2.message : text2(detail.detail);
      throw new Error(message || `Frejun returned ${status}.`);
    }
    if (total == null) total = num2(json2.count) || null;
    const results = Array.isArray(json2.results) ? json2.results : Array.isArray(asRecord2(json2.data).results) ? asRecord2(json2.data).results : [];
    for (const row of results) calls.push(mapCall2(asRecord2(row)));
    pages += 1;
    nextUrl = text2(json2.next) || null;
    if (!results.length) break;
  }
  const byNumber = /* @__PURE__ */ new Map();
  for (const call of calls) {
    const key = call.virtualNumber || "Unknown number";
    const list = byNumber.get(key) ?? [];
    list.push(call);
    byNumber.set(key, list);
  }
  const lines = [...byNumber.entries()].map(([e164, rows]) => {
    const answered2 = rows.filter((call) => call.answered).length;
    const talkSeconds2 = rows.reduce((sum, call) => sum + call.durationSeconds, 0);
    return {
      id: e164,
      name: e164,
      e164,
      calls: rows.length,
      answered: answered2,
      missed: rows.length - answered2,
      incoming: rows.filter((call) => call.direction === "incoming").length,
      outgoing: rows.filter((call) => call.direction === "outgoing").length,
      talkSeconds: talkSeconds2,
      answerRate: rows.length ? answered2 / rows.length : null,
      agents: new Set(rows.map((call) => call.agentName).filter((name) => name && name !== "Unassigned")).size
    };
  }).sort((a, b) => b.calls - a.calls);
  const agentMap = /* @__PURE__ */ new Map();
  for (const call of calls) {
    const row = agentMap.get(call.agentName) ?? { name: call.agentName, calls: 0, answered: 0, missed: 0, talkSeconds: 0 };
    row.calls += 1;
    row.talkSeconds += call.durationSeconds;
    if (call.answered) row.answered += 1;
    else row.missed += 1;
    agentMap.set(call.agentName, row);
  }
  const dailyMap = new Map(
    eachDay2(from, to).map((day) => [day, { key: day, label: day.slice(5), calls: 0, answered: 0, missed: 0, talkSeconds: 0 }])
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
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
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
      numbers: lines.length
    },
    lines,
    agents: [...agentMap.values()].sort((a, b) => b.calls - a.calls),
    calls: calls.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")),
    daily: [...dailyMap.values()]
  };
};

// src/http.ts
var dayPattern = /^\d{4}-\d{2}-\d{2}$/;
var timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
var routes = /* @__PURE__ */ new Set(["status", "report", "credentials", "frejun"]);
var authFailure = (message) => /unauthor|forbidden|rejected the key|\b401\b|\b403\b/i.test(message);
var onVercel = () => Boolean(process.env.VERCEL);
var json = (status, body) => Response.json(body, { status });
var defaultRange = () => {
  const to = /* @__PURE__ */ new Date();
  const from = /* @__PURE__ */ new Date();
  from.setDate(from.getDate() - 29);
  const iso = (date) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  return { from: iso(from), to: iso(to) };
};
var routeOf = (url) => {
  const named = url.searchParams.get("route");
  if (named && routes.has(named)) return named;
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
};
var readRange = (url) => {
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
var handleApi = async (request) => {
  const url = new URL(request.url);
  const route = routeOf(url);
  if (request.method === "GET" && route === "status") {
    return json(200, {
      configured: credentialsConfigured(),
      frejunConfigured: frejunConfigured(),
      host: onVercel() ? "vercel" : "local"
    });
  }
  if (request.method === "POST" && route === "credentials") {
    if (onVercel()) {
      return json(400, {
        message: "Set CLOUDTALK_KEY_ID and CLOUDTALK_KEY_SECRET in the Vercel project environment variables, then redeploy."
      });
    }
    try {
      const body = await request.json();
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
        message: onVercel() ? "Add FREJUN_API_KEY in the Vercel project environment variables, then redeploy." : "Add FREJUN_API_KEY to .env, then refresh."
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
        message: onVercel() ? "Set CLOUDTALK_KEY_ID and CLOUDTALK_KEY_SECRET in the Vercel project environment variables, then redeploy." : "Add the CloudTalk Access Key ID and Secret, then load the report again."
      });
    }
    const range = readRange(url);
    if (!range.ok) return range.response;
    const span = (Date.parse(`${range.to}T00:00:00`) - Date.parse(`${range.from}T00:00:00`)) / 864e5;
    if (span > 366) return json(400, { message: "Pick a range of 366 days or fewer." });
    try {
      const report = await buildReport(range.from, range.to, range.window);
      const failures = report.sources.filter((item) => item.error);
      if (failures.length === report.sources.length) {
        const message = failures[0]?.error || "CloudTalk did not return any data.";
        return json(authFailure(message) ? 401 : 502, {
          code: authFailure(message) ? "UNAUTHORIZED" : "UPSTREAM",
          message
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

// src/vercel-function.ts
var vercel_function_default = {
  fetch(request) {
    return handleApi(request);
  }
};
export {
  vercel_function_default as default
};
