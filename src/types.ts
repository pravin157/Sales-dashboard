export type SourceStatus = {
  id: string;
  label: string;
  ok: boolean;
  fetched: number;
  total: number | null;
  error?: string;
};

export type CallRow = {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  direction: string;
  answered: boolean;
  voicemail: boolean;
  recorded: boolean;
  externalNumber: string;
  internalNumber: string;
  internalName: string;
  agentId: string;
  agentName: string;
  contactId: string;
  contactName: string;
  company: string;
  talkingSeconds: number;
  waitingSeconds: number;
  billSeconds: number;
  tags: string[];
  recordingLink: string;
  lineId: string;
  lineName: string;
};

export type AgentRow = {
  id: string;
  name: string;
  email: string;
  extension: string;
  availability: string;
  outboundEnabled: boolean | null;
  defaultNumber: string;
  associatedNumbers: string[];
  calls: number;
  answered: number;
  missed: number;
  talkSeconds: number;
  lineIds: string[];
};

export type ContactRow = {
  id: string;
  name: string;
  company: string;
  title: string;
  industry: string;
  emails: string[];
  numbers: string[];
  tags: string[];
  type: string;
};

export type NumberRow = {
  id: string;
  name: string;
  e164: string;
  countryCode: string;
  areaCode: string;
  connectedTo: string;
  redirected: boolean;
};

export type GroupRow = {
  id: string;
  name: string;
};

export type GroupStat = {
  id: string;
  name: string;
  operators: number;
  answered: number;
  unanswered: number;
  abandonRate: number | null;
  avgWaitingSeconds: number | null;
  avgCallSeconds: number | null;
  queue: number | null;
};

export type LineSummary = {
  id: string;
  name: string;
  e164: string;
  connectedTo: string;
  callsLoaded: number;
  callsTotal: number | null;
  answered: number;
  missed: number;
  incoming: number;
  outgoing: number;
  internal: number;
  talkSeconds: number;
  answerRate: number | null;
  agents: number;
  error?: string;
};

export type TagRow = { id: string; name: string };

export type NoteRow = {
  id: string;
  contactId: string;
  userId: string;
  note: string;
  created: string | null;
};

export type Bucket = {
  key: string;
  label: string;
  calls: number;
  answered: number;
  missed: number;
  talkSeconds: number;
};

export type Report = {
  fetchedAt: string;
  range: { from: string; to: string };
  sources: SourceStatus[];
  summary: {
    callsLoaded: number;
    callsTotal: number | null;
    callsTruncated: boolean;
    answered: number;
    missed: number;
    incoming: number;
    outgoing: number;
    internal: number;
    voicemail: number;
    recorded: number;
    talkSeconds: number;
    waitingSeconds: number;
    answerRate: number | null;
    avgTalkSeconds: number | null;
    agents: number;
    onlineAgents: number;
    contactsLoaded: number;
    contactsTotal: number | null;
    numbers: number;
    groups: number;
    tags: number;
    notesLoaded: number;
    notesTotal: number | null;
  };
  daily: Bucket[];
  lines: LineSummary[];
  calls: CallRow[];
  agents: AgentRow[];
  contacts: ContactRow[];
  numbers: NumberRow[];
  groups: GroupRow[];
  groupStats: GroupStat[];
  tags: TagRow[];
  notes: NoteRow[];
};
