/**
 * Writing a key that came from **data**.
 *
 * The keys a catalogue, a provider or a file supplies are data, and a key
 * named `__proto__` must not replace the prototype of the object it is
 * written into. The keys are therefore **defined** rather than assigned, so
 * that such a key becomes an own data property and reaches nothing but
 * itself, and a lookup of a key in a plain object is guarded with
 * `Object.hasOwn`, so that a key of `"constructor"` or `"toString"` resolves
 * to the data and never to an inherited member.
 */

/**
 * Define a key on a plain object.
 *
 * The key becomes an **own data property**, so a key named `__proto__` is an
 * ordinary key and not a prototype assignment.
 */
export function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Merge one level of a plain object.
 *
 * A nested plain object is merged; every other value replaces what was there.
 * The source's own keys are the only ones read, and the target's own keys are
 * the only ones consulted.
 */
export function mergeOwn(
  target: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeOwn(existing, value);
      continue;
    }
    defineOwn(target, key, value);
  }
}

/** Whether a value is a plain object — not `null`, and not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
