/**
 * A brace- and string-aware scanner for the target's minified bundles.
 *
 * The bundles are minified, so the shape of a registry is only visible in the
 * *literals* it holds: a settings schema is one object literal, the environment
 * namespace is another, the command and flag registries are arrays of object
 * literals. A regular expression cannot read them — a brace inside a string
 * literal would corrupt the nesting, and a name that is a minified identifier
 * has to be resolved through the import graph.
 *
 * This scanner therefore does three things:
 *
 *   1. it finds the **top-level keys** of an object literal, skipping strings,
 *      template literals, escapes and comments;
 *   2. it finds the **string values** inside an object literal, in order;
 *   3. it finds every **call site** of a named function, so the registries can
 *      be located by their own entry point.
 *
 * It is deliberately simple and deliberately total: it never throws on
 * unbalanced input, because the input is a minified bundle and the point is to
 * survive whatever is in it.
 */

/** The kind of a scanned literal. */
export type LiteralKind = 'object' | 'array';

/** A scanned literal: its keys, its string values, and where it started. */
export interface ScannedLiteral {
  readonly kind: LiteralKind;
  /** The literal's top-level keys, in order. */
  readonly keys: readonly string[];
  /** Every string value in the literal, in order, nested ones included. */
  readonly strings: readonly string[];
  /** The offset the literal starts at. */
  readonly offset: number;
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/;

/**
 * The offset just past the string literal that starts at `at`.
 *
 * The literal may be single-quoted, double-quoted or a template literal, and it
 * may contain escapes. An unterminated literal runs to the end of the file,
 * which is the safe answer for a scan that must not fail.
 */
export function endOfString(text: string, at: number): number {
  const quote = text[at];
  if (quote !== '"' && quote !== "'" && quote !== '`') return at + 1;
  let index = at + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

/**
 * The offset of the `}` that closes the `{` at `at`, or -1.
 *
 * Braces inside strings, template literals, and comments are skipped.
 */
export function endOfObject(text: string, at: number): number {
  if (text[at] !== '{') return -1;
  let depth = 0;
  let index = at;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index = endOfString(text, index);
      continue;
    }
    if (character === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
}

/**
 * The top-level keys of the object literal that starts at `at`.
 *
 * A key is a string literal or a bare identifier. A **computed** key
 * (`[expr]`) is skipped: its name cannot be read statically.
 */
export function keysOfObject(text: string, at: number): string[] {
  if (text[at] !== '{') return [];
  const end = endOfObject(text, at);
  if (end === -1) return [];
  const keys: string[] = [];
  let index = at + 1;
  let depth = 0;
  let expectingKey = true;
  while (index < end) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      const stop = endOfString(text, index);
      if (expectingKey && depth === 0) {
        const literal = text.slice(index + 1, stop - 1);
        if (!literal.includes('${')) keys.push(literal);
      }
      index = stop;
      expectingKey = false;
      continue;
    }
    if (character === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? end : newline;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? end : close + 2;
      continue;
    }
    if (character === '[') {
      // A computed key: skip it whole, and the name is not readable.
      let square = 0;
      while (index < end) {
        const inner = text[index];
        if (inner === '"' || inner === "'" || inner === '`') {
          index = endOfString(text, index);
          continue;
        }
        if (inner === '[') square += 1;
        else if (inner === ']') {
          square -= 1;
          if (square === 0) {
            index += 1;
            break;
          }
        }
        index += 1;
      }
      expectingKey = false;
      continue;
    }
    if (character === '.' && text.startsWith('...', index) && depth === 0 && expectingKey) {
      // A **spread** (`...name(...)`) is not a key: the members it contributes
      // come from elsewhere, and reading the name as a key would invent one.
      index += 3;
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(index));
      if (name !== null) index += name[0].length;
      let probe = index;
      while (probe < end && /\s/.test(text[probe] ?? '')) probe += 1;
      if (text[probe] === '(') {
        // The call's arguments are skipped whole, so a parameter name inside
        // them is never mistaken for a key.
        let inner = 0;
        while (probe < end) {
          const inner_character = text[probe];
          if (inner_character === '"' || inner_character === "'" || inner_character === '`') {
            probe = endOfString(text, probe);
            continue;
          }
          if (inner_character === '(') inner += 1;
          else if (inner_character === ')') {
            inner -= 1;
            if (inner === 0) {
              probe += 1;
              break;
            }
          }
          probe += 1;
        }
        index = probe;
      }
      expectingKey = false;
      continue;
    }
    if (character === '{' || character === '[' || character === '(') {
      depth += 1;
      index += 1;
      expectingKey = false;
      continue;
    }
    if (character === '}' || character === ']' || character === ')') {
      depth -= 1;
      index += 1;
      expectingKey = false;
      continue;
    }
    if (character === ':') {
      expectingKey = false;
      index += 1;
      continue;
    }
    if (character === ',') {
      expectingKey = depth === 0;
      index += 1;
      continue;
    }
    if (depth === 0 && expectingKey) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(index));
      if (match !== null && match[0].length > 0) {
        keys.push(match[0]);
        index += match[0].length;
        expectingKey = false;
        continue;
      }
    }
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      index += 1;
      continue;
    }
    index += 1;
  }
  return keys;
}

/** Every string literal in the object or array literal that starts at `at`. */
export function stringsOfLiteral(text: string, at: number): string[] {
  const open = text[at];
  const end = open === '{' ? endOfObject(text, at) : -1;
  const stop = end === -1 ? text.length : end;
  const strings: string[] = [];
  let index = at;
  while (index < stop) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      const literalEnd = endOfString(text, index);
      const literal = text.slice(index + 1, literalEnd - 1);
      if (!literal.includes('${')) strings.push(literal);
      index = literalEnd;
      continue;
    }
    index += 1;
  }
  return strings;
}

/** Scan the literal at `at`. */
export function scanLiteral(text: string, at: number): ScannedLiteral {
  const kind: LiteralKind = text[at] === '{' ? 'object' : 'array';
  return {
    kind,
    keys: kind === 'object' ? keysOfObject(text, at) : [],
    strings: stringsOfLiteral(text, at),
    offset: at,
  };
}

/**
 * Every offset at which `name(` appears as a call.
 *
 * The check is on the identifier's boundary, so `L3(` does not match `XL3(`.
 */
export function callSites(text: string, name: string): number[] {
  const offsets: number[] = [];
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
  for (const match of text.matchAll(pattern)) {
    offsets.push(match.index ?? 0);
  }
  return offsets;
}

/** The offset of the `{` that opens the argument of the call at `at`. */
export function argumentObjectAt(text: string, at: number): number {
  const open = text.indexOf('(', at);
  if (open === -1) return -1;
  let index = open + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      index += 1;
      continue;
    }
    if (character === '{') return index;
    return -1;
  }
  return -1;
}

/**
 * The offset of the `{` that opens the **nth** argument of the call at `at`.
 *
 * The arguments are split at the top level of the call's parentheses, so a
 * comma inside a nested literal does not split them.
 */
export function nthArgumentObjectAt(text: string, at: number, nth: number): number {
  const open = text.indexOf('(', at);
  if (open === -1) return -1;
  let index = open + 1;
  let depth = 0;
  let argument = 0;
  let start = index;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index = endOfString(text, index);
      continue;
    }
    if (character === '{' || character === '[' || character === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === '}' || character === ']' || character === ')') {
      if (depth === 0) {
        // The call ended.
        if (argument === nth) return start;
        return -1;
      }
      depth -= 1;
      index += 1;
      continue;
    }
    if (character === ',' && depth === 0) {
      if (argument === nth) {
        let probe = index + 1;
        while (probe < text.length && /\s/.test(text[probe] ?? '')) probe += 1;
        return text[probe] === '{' ? probe : -1;
      }
      argument += 1;
      index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
  return -1;
}

/**
 * The string elements of the array literal that starts at `at`.
 *
 * An array literal can hold a **spread** (`...[...]`), which a regular
 * expression cannot cross, so the array is read with the same balance
 * discipline as an object.
 */
export function elementsOfArray(text: string, at: number): string[] {
  if (text[at] !== '[') return [];
  let depth = 0;
  let index = at;
  let end = -1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index = endOfString(text, index);
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
    index += 1;
  }
  if (end === -1) return [];
  const elements: string[] = [];
  index = at + 1;
  while (index < end) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      const literalEnd = endOfString(text, index);
      const literal = text.slice(index + 1, literalEnd - 1);
      if (!literal.includes('${')) elements.push(literal);
      index = literalEnd;
      continue;
    }
    index += 1;
  }
  return elements;
}

/**
 * Every array or set literal in the text that holds at least `minimum`
 * string members, with where it starts.
 */
export function collections(
  text: string,
  minimum: number,
): { members: string[]; offset: number }[] {
  const found: { members: string[]; offset: number }[] = [];
  for (const match of text.matchAll(/(?:new Set\(|\[|=\[)/g)) {
    const at = match.index ?? 0;
    const open = text.indexOf('[', at);
    if (open === -1) continue;
    const members = elementsOfArray(text, open);
    if (members.length >= minimum) found.push({ members, offset: open });
  }
  return found;
}

/**
 * The `name` member of every object in the array literal that starts at `at`.
 *
 * An array of tool definitions holds objects, not strings, and the name is
 * the member that identifies the tool. A name that is a **minified identifier**
 * is returned as the identifier, and the caller resolves it.
 */
export function nameExpressionsOfObjectArray(text: string, at: number): string[] {
  if (text[at] !== '[') return [];
  let depth = 0;
  let index = at;
  let end = -1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index = endOfString(text, index);
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
    index += 1;
  }
  if (end === -1) return [];
  // The elements, one by one: each is a literal that starts at the top level.
  const names: string[] = [];
  index = at + 1;
  while (index < end) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index = endOfString(text, index);
      continue;
    }
    if (character === '{') {
      const literalEnd = endOfObject(text, index);
      const slice = text.slice(index, literalEnd);
      const literal = /[{,]\s*name\s*:\s*"([^"]+)"/.exec(slice);
      if (literal !== null) {
        names.push(literal[1] ?? '');
        continue;
      }
      // The name is a **minified identifier** in the target's own source, and it
      // is resolved by the caller.
      const identifier = /[{,]\s*name\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(slice);
      if (identifier !== null) names.push(identifier[1] ?? '');
      index = literalEnd;
      continue;
    }
    index += 1;
  }
  return names;
}
