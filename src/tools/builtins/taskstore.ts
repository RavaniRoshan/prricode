/**
 * The **task store**: the session's task list.
 *
 * Evidence: the target's `TaskCreate`, `TaskGet`, `TaskList` and `TaskUpdate`
 * tools, read out of the pinned build (`chunk-705mhzj8.js:138696`,
 * `:140904`, `:150065` and `:145216`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The target's own input and output shapes, reproduced.**
 *
 *   - `TaskCreate` takes a `subject`, a `description`, an optional `activeForm` and
 *     an optional `metadata` map, and answers with `{ task: { id, subject } }`.
 *   - `TaskGet` takes a `taskId` and answers with the task — `id`, `subject`,
 *     `description`, `status`, `blocks` and `blockedBy` — or with a **null** task
 *     when there is none.
 *   - `TaskList` takes nothing and answers with the tasks — `id`, `subject`,
 *     `status`, an optional `owner` and `blockedBy`.
 *   - `TaskUpdate` takes a `taskId` and the fields to change, and answers with the
 *     fields it changed.
 *
 * **A dependency that is completed is not reported as a blocker.** The target
 * filters the `blockedBy` list of the tasks it lists against the ids of the
 * completed tasks, and this implementation does the same: a task that is blocked
 * only by finished work is not blocked.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **statuses** are `pending`, `in_progress` and `completed`, and `deleted`.
 *     The target's status set is read out of its own schema (`vve().or(A("deleted"))`),
 *     and the four names are this implementation's reading of it.
 *   - The ids are **numbers**, and the target's own tools answer with them as
 *     strings (`#1`, `#2`). The store hands out the numbers and the tools format
 *     them.
 *   - The store is **in memory** and per session.
 */

/** The status of a task. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/** One task of the task list. */
export interface Task {
  /** The task's id. */
  id: string;
  /** The task's title. */
  subject: string;
  /** What needs to be done. */
  description: string;
  /** The present continuous form, shown while the task is in progress. */
  activeForm?: string;
  /** Where the task stands. */
  status: TaskStatus;
  /** Who owns the task. */
  owner?: string;
  /** The ids of the tasks this one blocks. */
  blocks: string[];
  /** The ids of the tasks that block this one. */
  blockedBy: string[];
  /** Arbitrary metadata attached to the task. */
  metadata?: Record<string, unknown>;
}

/**
 * The session's task list.
 *
 * The store is **the** list: `TaskCreate` adds to it, `TaskUpdate` changes it,
 * `TaskGet` and `TaskList` report it, and all four hold the same instance.
 */
export class TaskStore {
  /** The tasks, keyed by id. */
  private readonly tasks = new Map<string, Task>();

  /** The id the next created task gets. */
  private nextId = 1;

  /** The task with that id, or `undefined` when there is none. */
  get(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;
    return { ...task, blocks: [...task.blocks], blockedBy: [...task.blockedBy] };
  }

  /** Every task the store holds, in creation order. */
  list(): Task[] {
    return [...this.tasks.values()].map((task) => ({
      ...task,
      blocks: [...task.blocks],
      blockedBy: [...task.blockedBy],
    }));
  }

  /** Add a task and return it. */
  create(input: {
    subject: string;
    description: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
  }): Task {
    const id = String(this.nextId);
    this.nextId += 1;
    const task: Task = {
      id,
      subject: input.subject,
      description: input.description,
      status: 'pending',
      blocks: [],
      blockedBy: [],
      ...(input.activeForm === undefined ? {} : { activeForm: input.activeForm }),
      ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
    };
    this.tasks.set(id, task);
    return { ...task };
  }

  /**
   * Change a task and return the fields that changed.
   *
   * A field that was not named is not changed, and a field that was named is
   * reported as changed even when the new value equals the old one: the target
   * reports the fields the call named.
   */
  update(
    id: string,
    changes: {
      subject?: string;
      description?: string;
      activeForm?: string;
      status?: TaskStatus;
      owner?: string;
      addBlocks?: string[];
      addBlockedBy?: string[];
      metadata?: Record<string, unknown | null>;
    },
  ): { updatedFields: string[] } | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;

    const updatedFields: string[] = [];
    if (changes.subject !== undefined) {
      task.subject = changes.subject;
      updatedFields.push('subject');
    }
    if (changes.description !== undefined) {
      task.description = changes.description;
      updatedFields.push('description');
    }
    if (changes.activeForm !== undefined) {
      task.activeForm = changes.activeForm;
      updatedFields.push('activeForm');
    }
    if (changes.status !== undefined) {
      task.status = changes.status;
      updatedFields.push('status');
    }
    if (changes.owner !== undefined) {
      task.owner = changes.owner;
      updatedFields.push('owner');
    }
    if (changes.addBlocks !== undefined) {
      task.blocks = [...new Set([...task.blocks, ...changes.addBlocks])];
      updatedFields.push('blocks');
    }
    if (changes.addBlockedBy !== undefined) {
      task.blockedBy = [...new Set([...task.blockedBy, ...changes.addBlockedBy])];
      updatedFields.push('blockedBy');
    }
    if (changes.metadata !== undefined) {
      const metadata = { ...(task.metadata ?? {}) };
      for (const [key, value] of Object.entries(changes.metadata)) {
        if (value === null) delete metadata[key];
        else metadata[key] = value;
      }
      task.metadata = metadata;
      updatedFields.push('metadata');
    }
    return { updatedFields };
  }
}
