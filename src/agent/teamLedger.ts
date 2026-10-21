/**
 * The **name-collision ledger** for the agent team.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded
 * in `/home/shiva/opt/reference-agent-rea/analysis/findings-agent-teams.md`:
 *
 *   - `chunk-jdykmg3v.js:3389` — `var Sh="main"`; `:8640` — the name
 *     normalisation; `:9134` — the reserved-name test.
 *   - `chunk-fvj2e8y8.js:2348` — `var Ia="team-lead",zMe="user",vyt="system"`;
 *     `:2391` — the agent-id shape; `:2175` — the teammate id.
 *   - `chunk-qsxcbpmk.js:1531` — the `@` sanitisation; `:1463` — the slug.
 *   - `chunk-xbdsavh3.js:20415` — the unique-name rule (`-2`, `-3`, …);
 *     `:18951` — the identity reservation.
 *   - `chunk-4jsg44k7.js:3562193` — the record-source mapping;
 *     `:3562216` — the settle record; `:3563019` — the outcome map.
 *   - `chunk-1vypyz65.js:11430` — the `Agent` tool's own `name` validation.
 *
 * **The record's enumeration was wrong.** The baseline record
 * (`findings-untouched-surfaces.md` §G14) said `recordSource` was
 * `collision | auto | own-name | superseded` and that `settle` was
 * `pre-decided | own-name | superseded | held | yielded`. The source says
 * otherwise: `recordSource` carries the **request's source**, and `own-name`
 * and `superseded` are **`settle`** values. And `settle` has **six** values,
 * not five — `kept` is the sixth. The two axes are corrected here, and the
 * correction is recorded in the findings file.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **record shapes** are this implementation's own TypeScript, but every
 *     field name and every value in them is the target's.
 *   - The **exports** are this implementation's own; the target's are internal.
 */

/* -------------------------------------------------------------------------- */
/* The reserved names                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The reserved recipient names.
 *
 * The target's own error text names them: `"main"`, `"team-lead"`, `"user"` and
 * `"system"`. `main` is the main conversation — `SendMessage` routes it there —
 * and the other three address the harness itself.
 */
export const RESERVED_TEAMMATE_NAMES: readonly string[] = ['main', 'team-lead', 'user', 'system'];

/**
 * The shape of a teammate's **name**.
 *
 * The target's `Agent` tool validates the `name` field against this shape: a
 * name starts with a letter or a digit, and carries letters, digits,
 * underscores and hyphens, up to 64 characters.
 */
export const TEAMMATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The shape of an **agent id**.
 *
 * An agent id already addresses an agent directly, so a name with this shape
 * may not be used as a teammate's name. The target's parser accepts
 * `a<16 hex>` and `a<name>-<16 hex>`.
 */
export const AGENT_ID_PATTERN = /^a(?:[\w-]{1,63}-)?[0-9a-f]{16}$/;

/**
 * Normalise a name for comparison.
 *
 * The target compares names after normalising them, so the reserved-name test
 * is spelling-insensitive: `MAIN`, `Team-Lead` and `  user  ` are all reserved.
 */
export function normalizeTeammateName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, (character) => (/\s/.test(character) ? character : ''))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

/**
 * Whether a name is one of the reserved names.
 */
export function isReservedTeammateName(name: string): boolean {
  const normalized = normalizeTeammateName(name);
  return RESERVED_TEAMMATE_NAMES.includes(normalized);
}

/**
 * Whether a name has the shape of an agent id.
 */
export function isAgentIdShaped(name: string): boolean {
  return AGENT_ID_PATTERN.test(name);
}

/**
 * The sanitised name.
 *
 * The target replaces every `@` with a `-`, because an `@` separates an agent
 * from its team in the teammate id.
 */
export function sanitizeTeammateName(name: string): string {
  return name.replaceAll('@', '-');
}

/**
 * The teammate id: the name, an `@`, and the team.
 */
export function teammateId(name: string, teamName: string): string {
  return `${name}@${teamName}`;
}

/* -------------------------------------------------------------------------- */
/* The unique-name rule                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The name a teammate takes when the one that was asked for is taken.
 *
 * The comparison is **case-insensitive**, and the suffix is `-2`, `-3`, … — the
 * first free number, not the number of members. A name nobody holds is
 * returned unchanged.
 */
export function uniqueTeammateName(
  requested: string,
  members: readonly { name: string }[],
): string {
  const taken = new Set(members.map((member) => member.name.toLowerCase()));
  const candidate = sanitizeTeammateName(requested);
  if (!taken.has(candidate.toLowerCase())) return candidate;

  let suffix = 2;
  while (taken.has(`${candidate}-${suffix}`.toLowerCase())) suffix += 1;
  return `${candidate}-${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* The validation the Agent tool runs                                          */
/* -------------------------------------------------------------------------- */

/**
 * The validation a teammate's name runs.
 *
 * The three rules and their three messages are the target's own, taken from the
 * `Agent` tool's input schema: the shape, the `main` reservation, and the
 * reserved-name-or-agent-id test.
 */
export function validateTeammateName(
  name: string,
): { ok: true } | { ok: false; message: string } {
  if (!TEAMMATE_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message:
        'name must start with a letter or digit and contain only letters, digits, underscores, or hyphens (max 64 chars)',
    };
  }
  if (name === 'main') {
    return {
      ok: false,
      message: '"main" is reserved — SendMessage routes it to the main conversation',
    };
  }
  if (isReservedTeammateName(name) || isAgentIdShaped(name)) {
    return {
      ok: false,
      message:
        'name must not be a reserved name ("main", "team-lead", "user" or "system", in any spelling) or have the shape of an agent id — those already address an agent directly',
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* The settle record                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The six ways a name request settles.
 *
 * `pre-decided` — the request already came in as a collision; `own-name` — the
 * name is already this session's own; `superseded` — another record supersedes
 * it; `held` — the name is held by a live session; `yielded` — this session
 * yields the name; `kept` — the name was kept.
 */
export const TEAMMATE_SETTLE_VALUES = [
  'pre-decided',
  'own-name',
  'superseded',
  'held',
  'yielded',
  'kept',
] as const;

/** One of the six settle values. */
export type TeammateSettle = (typeof TEAMMATE_SETTLE_VALUES)[number];

/**
 * The sources a name request can carry.
 *
 * The field records where the request came from. A collision or a peer request
 * is recorded as a **hook** request, because the target raises the rename
 * through its hook seam.
 */
export const TEAMMATE_RECORD_SOURCES = ['collision', 'auto', 'user', 'peer', 'hook'] as const;

/** One of the record sources. */
export type TeammateRecordSource = (typeof TEAMMATE_RECORD_SOURCES)[number];

/**
 * The three outcomes a settle maps to.
 *
 * `held` and `yielded` are the same outcome — the name went to the other
 * session — and `kept`, `own-name` and `pre-decided` are the same outcome, the
 * name stayed here.
 */
export type TeammateOutcome = 'kept' | 'yielded' | 'superseded';

/**
 * The outcome a settle maps to.
 */
export function settleOutcome(settle: TeammateSettle): TeammateOutcome {
  switch (settle) {
    case 'superseded':
      return 'superseded';
    case 'yielded':
    case 'held':
      return 'yielded';
    case 'kept':
    case 'own-name':
    case 'pre-decided':
      return 'kept';
  }
}

/**
 * The record a settled name request leaves.
 */
export interface TeammateSettleRecord {
  /** The name that was asked for. */
  requested: string;
  /** The name the request settled on. */
  name: string;
  /** Where the request came from. */
  recordSource: TeammateRecordSource;
  /** How the request settled. */
  settle: TeammateSettle;
  /** The name this session gave up, when it yielded one. */
  yieldedFrom?: { formerName: string; contested: string };
}

/* -------------------------------------------------------------------------- */
/* The team file                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One member of a team.
 *
 * The fields are the target's own: the identity, the colour, when it joined,
 * the pane it runs in, its subscriptions, and the metadata the spawn writes.
 */
export interface TeammateMember {
  /** The member's id — the name, an `@`, and the team. */
  agentId: string;
  /** The member's name. */
  name: string;
  /** The colour the member is addressed by. */
  color: string;
  /** When the member joined, in milliseconds since the epoch. */
  joinedAt: number;
  /** The pane the member runs in; `in-process` for an in-process teammate. */
  tmuxPaneId: string;
  /** The member's subscriptions. */
  subscriptions: string[];
  /** The kind of agent the member runs. */
  agentType?: string;
  /** The model the member runs on. */
  model?: string;
  /** The instructions the member was started with. */
  prompt?: string;
  /** Whether the member starts in plan mode. */
  planModeRequired?: boolean;
  /** The directory the member works in. */
  cwd?: string;
}

/**
 * Whether a value is a team member.
 *
 * The target keeps only the members that carry a string `agentId` and a string
 * `name`, and drops the rest when it reads the team file.
 */
export function isTeammateMember(value: unknown): value is TeammateMember {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['agentId'] === 'string' && typeof record['name'] === 'string';
}

/**
 * The team file: the members and whatever else the file carries.
 *
 * The target preserves the fields it does not know, so the file is not a
 * closed shape.
 */
export interface TeamFile {
  /** The team's members. */
  members: TeammateMember[];
  /** The fields the target does not know. */
  [key: string]: unknown;
}

/**
 * The members a team file holds, dropping the ones that are not members.
 *
 * The target keeps the file's other fields and replaces the member list with
 * the members that survived.
 */
export function teamFileMembers(file: unknown): TeamFile {
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return { members: [] };
  const record = file as Record<string, unknown>;
  const members = Array.isArray(record['members']) ? record['members'].filter(isTeammateMember) : [];
  if (Array.isArray(record['members']) && members.length === record['members'].length) {
    return record as TeamFile;
  }
  return { ...record, members };
}
