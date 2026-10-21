/**
 * **Checkpointing**: the file history the target keeps so that `/rewind` can restore
 * a file.
 *
 * Evidence: `chunk-c9s0jh80.js:320524` (the setting), `chunk-4jsg44k7.js:1244724` (the
 * switch), `:1244000`+ (the history), `chunk-kmrt4q1v.js:10067` (the cap), and the
 * record at `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §6.
 *
 * ## The switch
 *
 * The target's own rule, in the target's own order:
 *
 *   - in the **SDK** the checkpointing is **off**;
 *   - in a **host application** it is on only when
 *     `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` is set and
 *     `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` is not;
 *   - otherwise the **setting** decides — and the setting **defaults to on** — and
 *     `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` switches it off whatever the setting
 *     says.
 *
 * ## The history
 *
 * The target keeps a list of **snapshots**. A snapshot belongs to a **message**, and
 * carries the files it tracks and the **backup** of each of them — the backup's file
 * name and the backup's version. The list is capped, and the backups of the evicted
 * snapshots are deleted from the disk.
 *
 * ## What this implementation does not have
 *
 * The target's `/rewind` restores a file from a **backup on disk**, and this
 * implementation writes **no** backup store — so it cannot restore a file, and the
 * command **refuses** and names the capability it needs. The switch, the snapshot
 * shape and the eviction rule are implemented.
 */

import { homedir } from 'node:os';
import path from 'node:path';

/* -------------------------------------------------------------------------- */
/* The switch                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The environment variable that switches the checkpointing off.
 *
 * The target's own name.
 */
export const DISABLE_FILE_CHECKPOINTING_ENV = 'CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING';

/**
 * The environment variable that switches the checkpointing on in a host application.
 *
 * The target's own name.
 */
export const ENABLE_SDK_FILE_CHECKPOINTING_ENV = 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING';

/** Where the session runs. */
export type CheckpointingMode =
  /** The command line. */
  | 'cli'
  /** The SDK. */
  | 'sdk'
  /** A host application. */
  | 'host';

/** The switch's input. */
export interface CheckpointingOptions {
  /** Where the session runs. */
  readonly mode?: CheckpointingMode;
  /** The settings the session runs with. */
  readonly settings?: { readonly fileCheckpointingEnabled?: boolean } | undefined;
  /** The environment the session runs in. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Whether the file checkpointing is on.
 *
 * The target's own rule — see the module's own note.
 */
export function checkpointingEnabled(options: CheckpointingOptions = {}): boolean {
  const env = options.env ?? process.env;
  const mode = options.mode ?? 'cli';

  if (mode === 'sdk') return false;
  if (mode === 'host') {
    return (
      env[ENABLE_SDK_FILE_CHECKPOINTING_ENV] !== undefined &&
      env[DISABLE_FILE_CHECKPOINTING_ENV] === undefined
    );
  }

  const setting = options.settings?.fileCheckpointingEnabled;
  const enabled = setting === undefined ? true : setting === true;
  return enabled && env[DISABLE_FILE_CHECKPOINTING_ENV] === undefined;
}

/* -------------------------------------------------------------------------- */
/* The history                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The **cap** on the number of snapshots the target keeps.
 *
 * The target holds it in `pjt` (`chunk-kmrt4q1v.js:10067`).
 */
export const MAX_CHECKPOINT_SNAPSHOTS = 100;

/** One tracked file's backup. */
export interface FileCheckpointBackup {
  /** The file's path. */
  readonly path: string;
  /** The backup's file name, or `null` when the file had nothing to back up. */
  readonly backupFileName: string | null;
  /** The backup's version. */
  readonly version: number;
}

/** One snapshot. */
export interface FileCheckpointSnapshot {
  /** The message the snapshot belongs to. */
  readonly messageId: string;
  /** The files the snapshot tracks. */
  readonly trackedFiles: ReadonlyMap<string, FileCheckpointBackup>;
  /** Whether the snapshot was taken **before** the message. */
  readonly preCheckpoint?: boolean;
}

/** The file history. */
export interface FileHistory {
  /** The snapshots, oldest first. */
  readonly snapshots: readonly FileCheckpointSnapshot[];
  /** The number of snapshots the history has taken. */
  readonly snapshotSequence: number;
  /** The number of times the history has been touched. */
  readonly trackSequence: number;
  /** The files the history tracks now. */
  readonly trackedFiles: ReadonlyMap<string, FileCheckpointBackup>;
}

/** An empty history. */
export function emptyFileHistory(): FileHistory {
  return {
    snapshots: [],
    snapshotSequence: 0,
    trackSequence: 0,
    trackedFiles: new Map<string, FileCheckpointBackup>(),
  };
}

/**
 * Add a snapshot to a history.
 *
 * The target's rule: the snapshot is **appended**, the list is capped at the cap, and
 * the **evicted** snapshots are handed back so their backups can be deleted.
 */
export function addSnapshot(
  history: FileHistory,
  snapshot: FileCheckpointSnapshot,
): { history: FileHistory; evicted: readonly FileCheckpointSnapshot[] } {
  const snapshots = [...history.snapshots, snapshot];
  const evicted = snapshots.length > MAX_CHECKPOINT_SNAPSHOTS ? snapshots.slice(0, snapshots.length - MAX_CHECKPOINT_SNAPSHOTS) : [];
  const kept = snapshots.length > MAX_CHECKPOINT_SNAPSHOTS ? snapshots.slice(-MAX_CHECKPOINT_SNAPSHOTS) : snapshots;

  return {
    history: {
      ...history,
      snapshots: kept,
      snapshotSequence: (history.snapshotSequence ?? 0) + 1,
    },
    evicted,
  };
}

/**
 * The **backup files** a list of snapshots holds.
 *
 * The target collects the backup file names of the snapshots it is about to delete,
 * so it can delete exactly those that no kept snapshot refers to.
 */
export function backupFileNamesOf(snapshots: readonly FileCheckpointSnapshot[]): Set<string> {
  const names = new Set<string>();
  for (const snapshot of snapshots) {
    for (const backup of snapshot.trackedFiles.values()) {
      if (backup.backupFileName !== null) names.add(backup.backupFileName);
    }
  }
  return names;
}

/**
 * The backup files of the **evicted** snapshots that no kept snapshot refers to.
 *
 * The target's rule: a backup that a kept snapshot also holds is **not** deleted.
 */
export function evictedBackupFileNames(
  evicted: readonly FileCheckpointSnapshot[],
  kept: readonly FileCheckpointSnapshot[],
): string[] {
  const keptNames = backupFileNamesOf(kept);
  const names = new Set<string>();
  for (const snapshot of evicted) {
    for (const backup of snapshot.trackedFiles.values()) {
      const name = backup.backupFileName;
      if (name === null) continue;
      if (keptNames.has(name)) continue;
      if (backup.version === 1) continue;
      names.add(name);
    }
  }
  return [...names];
}

/* -------------------------------------------------------------------------- */
/* The refusal                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The capability `/rewind` needs and this implementation does not have.
 *
 * The target restores a file from a **backup on disk**; this implementation writes no
 * backup store, so it has nothing to restore from.
 */
export const REWIND_MISSING_CAPABILITY =
  'a file backup store, which /rewind restores a file from and this implementation does not write';

/**
 * The **backup directory** the target keeps its backups in.
 *
 * The target keeps them under the configuration root; this implementation writes
 * none, so the path is only here so that a caller can name it in a refusal.
 */
export function checkpointDirectory(configRoot: string = path.join(homedir(), '.claude')): string {
  return path.join(configRoot, 'file-history');
}
