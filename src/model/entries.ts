/**
 * Reading a catalogue entry out of a payload.
 *
 * The catalogue is **data**, and this module is where data comes in. Every
 * field is read defensively: a payload that does not carry a field leaves the
 * model with the default, and a payload that carries a field of the wrong
 * shape leaves the model without it. Nothing here guesses, and nothing here
 * knows any endpoint's vocabulary beyond the shapes in `src/model/types.ts`.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §3.
 */

import type {
  CatalogueDocument,
  Dialect,
  ModelCapabilities,
  ModelEntry,
  Modality,
  Overlay,
  OverlaySpelling,
  ReasoningSupport,
} from './types.js';
import { DIALECTS } from './types.js';

/** Whether a value is a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string member of a record, read as an own property. */
function ownString(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** A number member of a record, read as an own property. */
function ownNumber(record: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A boolean member of a record, read as an own property. */
function ownBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** A record member of a record, read as an own property. */
function ownRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

/** An array member of a record, read as an own property. */
function ownArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

/** The modalities a payload may name. */
const MODALITIES: readonly Modality[] = ['text', 'image', 'audio', 'pdf', 'video'];

/** Read a list of modalities, dropping the ones that are not modalities. */
function readModalities(value: unknown[] | undefined): readonly Modality[] {
  if (!value) return [];
  const found: Modality[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const modality = MODALITIES.find((candidate) => candidate === entry);
    if (modality) found.push(modality);
  }
  return found;
}

/** The capabilities a model has when the payload says nothing. */
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  input: ['text'],
  output: ['text'],
  temperature: true,
  tools: true,
};

/** Read a model's capabilities. */
function readCapabilities(payload: Record<string, unknown>): ModelCapabilities {
  const capabilities = ownRecord(payload, 'capabilities');
  if (!capabilities) return DEFAULT_CAPABILITIES;
  return {
    input: readModalities(ownArray(capabilities, 'input')) ?? DEFAULT_CAPABILITIES.input,
    output: readModalities(ownArray(capabilities, 'output')) ?? DEFAULT_CAPABILITIES.output,
    temperature: ownBoolean(capabilities, 'temperature') ?? DEFAULT_CAPABILITIES.temperature,
    tools: ownBoolean(capabilities, 'tools') ?? DEFAULT_CAPABILITIES.tools,
  };
}

/** Read a spelling: the fields, the headers and the body it contributes. */
function readSpelling(payload: unknown): OverlaySpelling | undefined {
  if (!isRecord(payload)) return undefined;
  const fields = ownRecord(payload, 'fields');
  const headers = ownRecord(payload, 'headers');
  const body = ownRecord(payload, 'body');
  const spelling: {
    fields?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {};
  if (fields) spelling.fields = fields;
  if (body) spelling.body = body;
  if (headers) {
    const read: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string') read[name] = value;
    }
    spelling.headers = read;
  }
  return spelling;
}

/** Read one overlay declaration. */
function readOverlay(payload: unknown): Overlay | undefined {
  if (!isRecord(payload)) return undefined;
  const kind = ownString(payload, 'kind');
  const name = ownString(payload, 'name');
  if (name === undefined) return undefined;

  const spellingsRecord = ownRecord(payload, 'spellings');
  const spellings: Partial<Record<Dialect, OverlaySpelling>> = {};
  if (spellingsRecord) {
    for (const dialect of DIALECTS) {
      if (!Object.hasOwn(spellingsRecord, dialect)) continue;
      const spelling = readSpelling(spellingsRecord[dialect]);
      if (spelling) spellings[dialect] = spelling;
    }
  }

  switch (kind) {
    case 'effort': {
      const effort = ownString(payload, 'effort');
      if (effort === undefined) return undefined;
      return { kind: 'effort', name, effort, spellings };
    }
    case 'toggle': {
      const enabled = ownBoolean(payload, 'enabled');
      if (enabled === undefined) return undefined;
      return { kind: 'toggle', name, enabled, spellings };
    }
    case 'budget_tokens': {
      const tokens = ownNumber(payload, 'tokens');
      if (tokens === undefined) return undefined;
      return { kind: 'budget_tokens', name, tokens, spellings };
    }
    case 'named':
      return { kind: 'named', name, spellings };
    default:
      return undefined;
  }
}

/** Read the overlays a model offers. */
function readOverlays(payload: Record<string, unknown>): readonly Overlay[] {
  const list = ownArray(payload, 'overlays');
  if (!list) return [];
  const overlays: Overlay[] = [];
  for (const entry of list) {
    const overlay = readOverlay(entry);
    if (overlay) overlays.push(overlay);
  }
  return overlays;
}

/** Read the support kinds a model offers. */
function readReasoning(payload: Record<string, unknown>): ReasoningSupport {
  const reasoning = ownRecord(payload, 'reasoning');
  if (!reasoning) return {};
  const support: {
    effort?: { values: readonly string[] };
    toggle?: boolean;
    budget?: { min?: number; max?: number };
  } = {};

  const effort = ownRecord(reasoning, 'effort');
  if (effort) {
    const values = ownArray(effort, 'values');
    if (values) {
      support.effort = {
        values: values.filter((value): value is string => typeof value === 'string'),
      };
    }
  }
  const toggle = ownBoolean(reasoning, 'toggle');
  if (toggle !== undefined) support.toggle = toggle;
  const budget = ownRecord(reasoning, 'budget');
  if (budget) {
    const min = ownNumber(budget, 'min');
    const max = ownNumber(budget, 'max');
    support.budget = {
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    };
  }
  return support;
}

/**
 * Read one model entry.
 *
 * A payload without an `id` is not a model, and is refused: an entry with no
 * identity could not be selected, and a catalogue that carried one would be
 * carrying a fact it cannot state.
 */
export function parseModelEntry(payload: unknown, provider: string): ModelEntry | undefined {
  if (!isRecord(payload)) return undefined;
  const id = ownString(payload, 'id');
  if (id === undefined || id === '') return undefined;

  const cost = ownRecord(payload, 'cost');
  const limits = ownRecord(payload, 'limits');

  const entry: {
    id: string;
    provider: string;
    capabilities: ModelCapabilities;
    cost?: { input: number; output: number };
    limits?: { context?: number; output?: number };
    overlays: readonly Overlay[];
    reasoning: ReasoningSupport;
    enabled: boolean;
  } = {
    id,
    provider: ownString(payload, 'provider') ?? provider,
    capabilities: readCapabilities(payload),
    overlays: readOverlays(payload),
    reasoning: readReasoning(payload),
    enabled: ownBoolean(payload, 'enabled') ?? true,
  };

  if (cost) {
    const input = ownNumber(cost, 'input');
    const output = ownNumber(cost, 'output');
    if (input !== undefined && output !== undefined) entry.cost = { input, output };
  }
  if (limits) {
    const context = ownNumber(limits, 'context');
    const output = ownNumber(limits, 'output');
    entry.limits = {
      ...(context === undefined ? {} : { context }),
      ...(output === undefined ? {} : { output }),
    };
  }
  return entry;
}

/**
 * Read a list of models.
 *
 * The list is either a bare array or the object that carries one under `data`
 * or `models` — the three shapes a provider's own model list may take.
 */
export function parseModelList(payload: unknown, provider: string): readonly ModelEntry[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? (ownArray(payload, 'data') ?? ownArray(payload, 'models') ?? [])
      : [];
  const models: ModelEntry[] = [];
  for (const entry of list) {
    const model = parseModelEntry(entry, provider);
    if (model) models.push(model);
  }
  return models;
}

/**
 * Read a catalogue payload.
 *
 * Two shapes are accepted: the whole-document shape, which carries the
 * providers and their models, and the single-provider shape, which carries one
 * provider's model list.
 */
export function parseCataloguePayload(payload: unknown, provider: string): CatalogueDocument {
  if (isRecord(payload) && ownArray(payload, 'providers')) {
    const providers: { provider: string; models: readonly ModelEntry[] }[] = [];
    for (const entry of ownArray(payload, 'providers') ?? []) {
      if (!isRecord(entry)) continue;
      const name = ownString(entry, 'provider');
      if (name === undefined) continue;
      providers.push({ provider: name, models: parseModelList(entry, name) });
    }
    return { providers };
  }
  return { providers: [{ provider, models: parseModelList(payload, provider) }] };
}
