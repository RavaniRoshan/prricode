/**
 * Contract test: the **checkpointing** — the switch, the history, and the refusal.
 *
 * Evidence: `chunk-c9s0jh80.js:320524` (the setting), `chunk-4jsg44k7.js:1244724` (the
 * switch), `chunk-kmrt4q1v.js:10067` (the cap), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §6.
 */

import { describe, expect, it } from 'vitest';

import { runSlashCommand } from '../../src/cli/commands/slash.js';
import {
  DISABLE_FILE_CHECKPOINTING_ENV,
  ENABLE_SDK_FILE_CHECKPOINTING_ENV,
  MAX_CHECKPOINT_SNAPSHOTS,
  REWIND_MISSING_CAPABILITY,
  addSnapshot,
  backupFileNamesOf,
  checkpointingEnabled,
  emptyFileHistory,
  evictedBackupFileNames,
  type FileCheckpointSnapshot,
} from '../../src/session/checkpoints.js';

function snapshotOf(messageId: string, backups: Record<string, string | null>): FileCheckpointSnapshot {
  const trackedFiles = new Map<string, { path: string; backupFileName: string | null; version: number }>();
  for (const [path, name] of Object.entries(backups)) {
    trackedFiles.set(path, { path, backupFileName: name, version: 2 });
  }
  return { messageId, trackedFiles };
}

describe('the checkpointing switch', () => {
  it('is on by default', () => {
    expect(checkpointingEnabled({ mode: 'cli', env: {} })).toBe(true);
  });

  it('follows the setting when the setting says so', () => {
    expect(checkpointingEnabled({ mode: 'cli', settings: { fileCheckpointingEnabled: false }, env: {} })).toBe(
      false,
    );
    expect(checkpointingEnabled({ mode: 'cli', settings: { fileCheckpointingEnabled: true }, env: {} })).toBe(
      true,
    );
  });

  it('is switched off by the environment variable, whatever the setting says', () => {
    expect(
      checkpointingEnabled({
        mode: 'cli',
        settings: { fileCheckpointingEnabled: true },
        env: { [DISABLE_FILE_CHECKPOINTING_ENV]: '1' },
      }),
    ).toBe(false);
  });

  it('is off in the SDK', () => {
    expect(
      checkpointingEnabled({
        mode: 'sdk',
        env: { [ENABLE_SDK_FILE_CHECKPOINTING_ENV]: '1' },
      }),
    ).toBe(false);
  });

  it('follows the environment in a host application', () => {
    expect(checkpointingEnabled({ mode: 'host', env: {} })).toBe(false);
    expect(
      checkpointingEnabled({ mode: 'host', env: { [ENABLE_SDK_FILE_CHECKPOINTING_ENV]: '1' } }),
    ).toBe(true);
    expect(
      checkpointingEnabled({
        mode: 'host',
        env: {
          [ENABLE_SDK_FILE_CHECKPOINTING_ENV]: '1',
          [DISABLE_FILE_CHECKPOINTING_ENV]: '1',
        },
      }),
    ).toBe(false);
  });

  it('carries the target\'s own environment variable names', () => {
    expect(DISABLE_FILE_CHECKPOINTING_ENV).toBe('CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING');
    expect(ENABLE_SDK_FILE_CHECKPOINTING_ENV).toBe('CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING');
  });
});

describe('the file history', () => {
  it('starts empty', () => {
    const history = emptyFileHistory();
    expect(history.snapshots).toEqual([]);
    expect(history.snapshotSequence).toBe(0);
    expect(history.trackSequence).toBe(0);
  });

  it('appends a snapshot and counts it', () => {
    const { history } = addSnapshot(emptyFileHistory(), snapshotOf('m1', { '/a.ts': 'a.1' }));
    expect(history.snapshots).toHaveLength(1);
    expect(history.snapshotSequence).toBe(1);
  });

  it('evicts the oldest snapshots past the cap', () => {
    let history = emptyFileHistory();
    for (let index = 0; index < MAX_CHECKPOINT_SNAPSHOTS + 2; index += 1) {
      history = addSnapshot(history, snapshotOf(`m${index}`, {})).history;
    }
    expect(history.snapshots).toHaveLength(MAX_CHECKPOINT_SNAPSHOTS);
    expect(history.snapshots[0]?.messageId).toBe('m2');
  });

  it('hands the evicted snapshots back', () => {
    let history = emptyFileHistory();
    for (let index = 0; index < MAX_CHECKPOINT_SNAPSHOTS + 1; index += 1) {
      history = addSnapshot(history, snapshotOf(`m${index}`, {})).history;
    }
    const { evicted } = addSnapshot(history, snapshotOf('last', {}));
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.messageId).toBe('m1');
  });

  it('collects the backup file names of a list of snapshots', () => {
    const names = backupFileNamesOf([
      snapshotOf('m1', { '/a.ts': 'a.1', '/b.ts': null }),
      snapshotOf('m2', { '/c.ts': 'c.1' }),
    ]);
    expect([...names]).toEqual(['a.1', 'c.1']);
  });

  it('deletes only the backups no kept snapshot refers to', () => {
    const kept = [snapshotOf('m2', { '/a.ts': 'a.1' })];
    const evicted = [snapshotOf('m1', { '/a.ts': 'a.1', '/b.ts': 'b.1' })];
    expect(evictedBackupFileNames(evicted, kept)).toEqual(['b.1']);
  });
});

describe('the rewind command', () => {
  it('refuses and names the capability it needs', async () => {
    const result = await runSlashCommand('/rewind', {
      store: { append: async () => undefined } as never,
      cwd: '/tmp',
      configDir: '/tmp',
      sessionId: 'session-1',
      model: 'claude-sonnet-4-5',
      version: '0.1.0',
      events: [],
      env: {},
      managerState: async () => ({ registry: {} as never, catalogs: {} as never }),
      managerOptions: () => ({}),
    });

    expect(result?.exitCode).not.toBe(0);
    expect(result?.stderr).toContain('/rewind');
    expect(result?.stderr).toContain('file backup store');
  });

  it('names the capability in the module', () => {
    expect(REWIND_MISSING_CAPABILITY).toContain('file backup store');
  });
});
