/**
 * The **todo store**: the session's task checklist.
 *
 * Evidence: the target's `TodoWrite` tool, read out of the pinned build
 * (`chunk-705mhzj8.js:61266`), and the `CC-027` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The list is session state, not a file.** The target's `TodoWrite` reads the
 * list the agent owns, replaces it, and reports the old and the new list; the
 * store is what makes that possible, and what makes a **read** of the list
 * possible at all.
 *
 * **The target's own behaviour, reproduced.** The target clears the list when
 * every item is completed (`r.every(h=>h.status==="completed")` → the list is set
 * to the empty list), and it reports the list it replaced as `oldTodos` and the
 * list it wrote as `newTodos`.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The statuses are exactly `pending`, `in_progress` and `completed`. The audit
 *     does not name them, so this implementation does not claim them.
 *   - The store is **in memory** and per session. Where a session persists it is
 *     the session store's business.
 */

/** The status of a todo item. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One item of the todo list. */
export interface Todo {
  /** What the item is. */
  content: string;
  /** Where the item stands. */
  status: TodoStatus;
  /** The present continuous form of the item. */
  activeForm: string;
}

/**
 * The session's todo list.
 *
 * The store is **the** list: `TodoWrite` replaces it and `TodoRead` reports it,
 * and both tools hold the same store instance.
 */
export class TodoStore {
  /** The list, or the empty list when nothing was written yet. */
  private todos: Todo[] = [];

  /** The list as it stands. */
  list(): Todo[] {
    return this.todos.map((todo) => ({ ...todo }));
  }

  /**
   * Replace the list.
   *
   * The target clears the list when every item is completed, and this
   * implementation does the same: the checklist of a finished task is empty.
   */
  set(todos: Todo[]): { oldTodos: Todo[]; newTodos: Todo[] } {
    const oldTodos = this.list();
    const next = todos.map((todo) => ({ ...todo }));
    this.todos = next.every((todo) => todo.status === 'completed') ? [] : next;
    return { oldTodos, newTodos: this.list() };
  }
}
