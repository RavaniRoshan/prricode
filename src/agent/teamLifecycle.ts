/**
 * The **team lifecycle**: the team file, the identity reservation, the
 * transitions a teammate goes through, and the hook the target raises when a
 * teammate goes idle.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded
 * in `/home/shiva/opt/reference-agent-rea/analysis/findings-agent-teams.md`:
 *
 *   - `chunk-qsxcbpmk.js:1463` — the slug; `:1576` and `:1613` — the team
 *     directory and the team file; `:2204` — the member validation;
 *     `:3751` and `:4431` — the write under a lock, and the retry loop;
 *     `:6309`, `:6947`, `:7524`, `:8051` — the member operations;
 *     `:8504`, `:8869`, `:8924`, `:9568` — the teardown.
 *   - `chunk-xbdsavh3.js:18951` — the identity reservation; `:20415` — the
 *     unique-name rule; the same chunk — the team context and the in-process
 *     teammate.
 *   - `chunk-2pn9kb04.js:22932` — the inbox path; `:20053` — the message
 *     record; `:46138` — the prompt refusal.
 *   - `chunk-4jsg44k7.js:3560929` — the `TeammateIdle` hook payload.
 *   - `chunk-4c76z8tx.js:7790` — the hook's own descriptor.
 *
 * **The honest boundary.** This implementation has **no team backend**: no
 * teammate service, no teammate runtime, no pane and no cross-session
 * transport. So the **shapes** are implemented — the team file's layout, the
 * member record, the identity reservation, the unique-name rule, the states a
 * teammate goes through and the idle hook's payload — and the operations that
 * would need a teammate runtime **refuse**, naming the capability they needed.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **states** are this implementation's own. The target's lifecycle is
 *     spread over the task registry, the team file and the pane registry, and
 *     it does not name the states.
 *   - The **configuration root** is a parameter, so the caller supplies the
 *     root the target's `~/.claude` would be.
 */

import path from 'node:path';

import {
  teammateId,
  uniqueTeammateName,
  type TeammateMember,
} from './teamLedger.js';

/* -------------------------------------------------------------------------- */
/* The layout                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The slug a team's name becomes.
 *
 * The target replaces every character that is not a letter or a digit with a
 * `-` and lowercases the result.
 */
export function teamSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

/**
 * The slug an agent's name becomes inside a team's directory.
 */
function agentSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/** The teams directory, under the configuration root. */
export const TEAMS_DIRECTORY = 'teams';

/**
 * The team's directory: `<root>/teams/<slug>`.
 */
export function teamDirectory(configRoot: string, teamName: string): string {
  return path.join(configRoot, TEAMS_DIRECTORY, teamSlug(teamName));
}

/**
 * The team's file: `<root>/teams/<slug>/config.json`.
 */
export function teamFilePath(configRoot: string, teamName: string): string {
  return path.join(teamDirectory(configRoot, teamName), 'config.json');
}

/**
 * A teammate's inbox: `<root>/teams/<slug>/inboxes/<agent>.json`.
 */
export function teammateInboxPath(
  configRoot: string,
  teamName: string,
  agentName: string,
): string {
  return path.join(teamDirectory(configRoot, teamName), 'inboxes', `${agentSlug(agentName)}.json`);
}

/* -------------------------------------------------------------------------- */
/* The identity                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a spawn asks for.
 */
export interface TeammateSpawnRequest {
  /** The name the teammate is asked for. */
  name: string;
  /** The colour the teammate is addressed by. */
  color: string;
  /** The kind of agent the teammate runs. */
  agentType?: string;
  /** The model the teammate runs on. */
  model?: string;
  /** The instructions the teammate is started with. */
  prompt?: string;
  /** Whether the teammate starts in plan mode. */
  planModeRequired?: boolean;
  /** The directory the teammate works in. */
  cwd?: string;
}

/**
 * The identity a spawn reserves.
 */
export interface ReservedTeammateIdentity {
  /** The name the teammate actually takes — the unique one. */
  name: string;
  /** The teammate's id — the name, an `@`, and the team. */
  agentId: string;
  /** The member record the team file carries. */
  member: TeammateMember;
}

/**
 * The control characters a name may not carry.
 *
 * The target refuses a name or a team name that carries one, because the name
 * is written into a terminal pane's command line.
 */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * Reserve a teammate's identity.
 *
 * The target's own sequence: the name and the team name are checked for
 * control characters, the name is made unique against the team's members, the
 * id is built, and the member record is written.
 *
 * **This implementation does not write the team file** — there is no teammate
 * runtime here, and a file listing teammates that do not exist would be a lie.
 * The *record* is returned; the caller decides what to do with it.
 */
export function reserveTeammateIdentity(input: {
  /** The name the teammate is asked for. */
  name: string;
  /** The team's name. */
  teamName: string;
  /** The members the team already holds. */
  members: readonly { name: string }[];
  /** The colour the teammate is addressed by. */
  color: string;
  /** The kind of agent the teammate runs. */
  agentType?: string;
  /** The model the teammate runs on. */
  model?: string;
  /** The instructions the teammate is started with. */
  prompt?: string;
  /** Whether the teammate starts in plan mode. */
  planModeRequired?: boolean;
  /** The directory the teammate works in. */
  cwd?: string;
  /** When the teammate joined. */
  now?: number;
}): ReservedTeammateIdentity {
  if (CONTROL_CHARACTERS.test(input.name)) {
    throw new Error('Invalid name: control characters are not allowed in agent or team names');
  }
  if (CONTROL_CHARACTERS.test(input.teamName)) {
    throw new Error(
      'Invalid team_name: control characters are not allowed in agent or team names',
    );
  }

  const name = uniqueTeammateName(input.name, input.members);
  const agentId = teammateId(name, input.teamName);
  const member: TeammateMember = {
    agentId,
    name,
    color: input.color,
    joinedAt: input.now ?? Date.now(),
    tmuxPaneId: '',
    subscriptions: [],
  };
  if (input.agentType !== undefined) member.agentType = input.agentType;
  if (input.model !== undefined) member.model = input.model;
  if (input.prompt !== undefined) member.prompt = input.prompt;
  if (input.planModeRequired !== undefined) member.planModeRequired = input.planModeRequired;
  if (input.cwd !== undefined) member.cwd = input.cwd;

  return { name, agentId, member };
}

/* -------------------------------------------------------------------------- */
/* The states                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The states a teammate goes through.
 *
 * The target's lifecycle is spread over the task registry, the team file and
 * the pane registry; the names here are this implementation's own.
 */
export type TeammateState = 'spawning' | 'running' | 'idle' | 'stopping' | 'stopped';

/**
 * One teammate in the team's lifecycle.
 */
export interface TeammateLifecycle {
  /** The teammate's id. */
  agentId: string;
  /** The teammate's name. */
  name: string;
  /** Where the teammate is. */
  state: TeammateState;
  /** When the teammate joined. */
  spawnedAt: number;
}

/**
 * The team's context.
 *
 * The fields are the target's own: the team's name, the path of its file, the
 * lead agent's id, and the teammates keyed by name.
 */
export interface TeamContext {
  /** The team's name. */
  teamName: string;
  /** The path of the team's file. */
  teamFilePath: string;
  /** The lead agent's id. */
  leadAgentId: string;
  /** The teammates, keyed by name. */
  teammates: Record<string, TeamContextTeammate>;
}

/**
 * One teammate in the team's context.
 */
export interface TeamContextTeammate {
  /** The teammate's name. */
  name: string;
  /** The kind of agent the teammate runs. */
  agentType?: string;
  /** The colour the teammate is addressed by. */
  color?: string;
  /** The session the teammate runs in. */
  tmuxSessionName: string;
  /** The pane the teammate runs in. */
  tmuxPaneId: string;
  /** The directory the teammate works in. */
  cwd: string;
  /** When the teammate joined. */
  spawnedAt: number;
}

/* -------------------------------------------------------------------------- */
/* The runtime                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The teammate runtime a session supplies.
 *
 * A runtime is what actually **runs** a teammate. This implementation has
 * none: there is no teammate service here, so a session that wants one has to
 * supply it, and a session that does not gets a refusal.
 */
export interface TeammateRuntime {
  /** Start a teammate and return its id. */
  start(request: {
    name: string;
    agentId: string;
    prompt?: string;
    model?: string;
    planModeRequired?: boolean;
    cwd?: string;
  }): Promise<string>;
  /** Stop a teammate. */
  stop(agentId: string): Promise<void>;
  /** Remove the team's file and its directory. */
  teardown(teamName: string): Promise<void>;
}

/**
 * The outcome of a spawn.
 */
export type TeammateSpawnOutcome =
  | {
      /** The teammate was started. */
      ok: true;
      /** The teammate's identity. */
      identity: ReservedTeammateIdentity;
      /** The teammate's lifecycle entry. */
      teammate: TeammateLifecycle;
    }
  | {
      /** The teammate was not started. */
      ok: false;
      /** The capability the spawn needed. */
      capability: string;
      /** The refusal. */
      message: string;
    };

/**
 * The team a session leads.
 */
export class TeamLifecycle {
  /** The team's name. */
  readonly teamName: string;

  /** The configuration root. */
  readonly configRoot: string;

  /** The teammate runtime, when the session has one. */
  private readonly runtime: TeammateRuntime | undefined;

  /** The teammates, keyed by name. */
  private readonly teammates = new Map<string, TeammateLifecycle>();

  constructor(options: { teamName: string; configRoot: string; runtime?: TeammateRuntime }) {
    this.teamName = options.teamName;
    this.configRoot = options.configRoot;
    this.runtime = options.runtime;
  }

  /**
   * Start a teammate.
   *
   * **There is no teammate runtime here.** The target starts a teammate in a
   * terminal pane or in this process; this implementation has neither, so the
   * spawn refuses and names the capability it needed.
   */
  async spawn(request: TeammateSpawnRequest): Promise<TeammateSpawnOutcome> {
    const members = [...this.teammates.values()].map((teammate) => ({ name: teammate.name }));
    const identity = reserveTeammateIdentity({
      name: request.name,
      teamName: this.teamName,
      members,
      color: request.color,
      agentType: request.agentType,
      model: request.model,
      prompt: request.prompt,
      planModeRequired: request.planModeRequired,
      cwd: request.cwd,
    });

    if (this.runtime === undefined) {
      return {
        ok: false,
        capability: 'a teammate runtime',
        message:
          'Starting a teammate needs a teammate runtime, which this session does not have, so the teammate was not started.',
      };
    }

    const started = await this.runtime.start({
      name: identity.name,
      agentId: identity.agentId,
      prompt: request.prompt,
      model: request.model,
      planModeRequired: request.planModeRequired,
      cwd: request.cwd,
    });

    const teammate: TeammateLifecycle = {
      agentId: started,
      name: identity.name,
      state: 'running',
      spawnedAt: Date.now(),
    };
    this.teammates.set(identity.name, teammate);
    return { ok: true, identity, teammate };
  }

  /**
   * Mark a teammate idle.
   *
   * The target raises its `TeammateIdle` hook at this point, with the
   * teammate's name and the team's name.
   */
  markIdle(agentId: string): boolean {
    for (const teammate of this.teammates.values()) {
      if (teammate.agentId !== agentId) continue;
      teammate.state = 'idle';
      return true;
    }
    return false;
  }

  /** The teammates, keyed by name. */
  list(): readonly TeammateLifecycle[] {
    return [...this.teammates.values()];
  }

  /**
   * The team's context.
   */
  context(): TeamContext {
    const teammates: Record<string, TeamContextTeammate> = {};
    for (const teammate of this.teammates.values()) {
      teammates[teammate.name] = {
        name: teammate.name,
        tmuxSessionName: 'in-process',
        tmuxPaneId: 'in-process',
        cwd: '',
        spawnedAt: teammate.spawnedAt,
      };
    }
    return {
      teamName: this.teamName,
      teamFilePath: teamFilePath(this.configRoot, this.teamName),
      leadAgentId: '',
      teammates,
    };
  }

  /**
   * Tear the team down.
   *
   * **There is no teammate runtime here**, so there is nothing that could kill
   * a pane or remove the team's file: the call refuses and names the
   * capability it needed.
   */
  async teardown(): Promise<void> {
    if (this.runtime === undefined) {
      throw new Error(
        'Tearing a team down needs a teammate runtime, which this session does not have, so the team was not torn down.',
      );
    }
    await this.runtime.teardown(this.teamName);
    this.teammates.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* The idle hook                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The payload the target's `TeammateIdle` hook carries.
 *
 * The target's own two fields are the teammate's name and the team's name.
 */
export interface TeammateIdleHookPayload {
  /** The event's name. */
  hook_event_name: 'TeammateIdle';
  /** The teammate that is about to go idle. */
  teammate_name: string;
  /** The team the teammate belongs to. */
  team_name: string;
}

/**
 * The payload the target's `TeammateIdle` hook carries.
 */
export function teammateIdleHookPayload(
  teammateName: string,
  teamName: string,
): TeammateIdleHookPayload {
  return {
    hook_event_name: 'TeammateIdle',
    teammate_name: teammateName,
    team_name: teamName,
  };
}
