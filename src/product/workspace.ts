/**
 * The workspace — **where the product's files live**.
 *
 * **One responsibility:** the directory the run writes into, and the paths it
 * writes at.
 *
 * ## The rule this module exists to keep
 *
 * > **A file the model named is a file the product writes — and never one
 * > outside the product's own directory.**
 *
 * The `build` stage produces files: a path, and the text of the file. The
 * product writes them, because **a file that was only described was never
 * built**. So the workspace is where the described files become real ones,
 * and the verification runs against *those* files — not against the
 * description of them.
 *
 * ## The paths are held to the root
 *
 * A path comes from a model's answer, and a model's answer is **data**. So a
 * path that is absolute, or that climbs out of the workspace with `..`, is
 * **refused with a reason** — it is not written, not trimmed, and not
 * "interpreted". A product that writes wherever it is told to is a product
 * that writes over things it was never asked to write.
 *
 * The path a file is written at is reported back, absolutely, so the caller
 * never has to guess where the file went.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A path the product refused to write. */
export class WorkspacePathError extends Error {
  /** The sentence that says why the path was refused. */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'WorkspacePathError';
    this.reason = reason.trim();
  }
}

/**
 * The path a file is written at, inside the root.
 *
 * The path is the caller's own — a model's answer — so it is checked before
 * anything is written: it must be relative, it must name a file, and it must
 * stay inside the root.
 */
export function resolveInRoot(root: string, relative: string): string {
  if (typeof relative !== 'string' || relative.trim().length === 0) {
    throw new WorkspacePathError('a file was named with no path');
  }
  const trimmed = relative.trim();
  if (path.isAbsolute(trimmed)) {
    throw new WorkspacePathError(
      `the file "${trimmed}" is named with an absolute path, and the product writes inside its own directory`,
    );
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, trimmed);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new WorkspacePathError(
      `the file "${trimmed}" is named outside the product's own directory, and it was not written`,
    );
  }
  return resolved;
}

/** The workspace — the directory the run writes into. */
export class ProductWorkspace {
  /** The directory the run writes into. */
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** The path a file is written at, inside the workspace. */
  resolve(relative: string): string {
    return resolveInRoot(this.root, relative);
  }

  /**
   * Write a file.
   *
   * The parent directories are created, because a product's file may live in
   * a directory the product has not made yet. The absolute path is returned,
   * so the caller knows where the file went.
   */
  async write(relative: string, content: string): Promise<string> {
    const target = this.resolve(relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    return target;
  }
}
