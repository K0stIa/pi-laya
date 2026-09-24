export type InventoryKind = "skill" | "tool" | "model";

export interface InventoryCandidate {
  id: string;
  label: string;
  description: string;
  source: InventoryKind;
}

export interface InventorySnapshot {
  skills: InventoryCandidate[];
  tools: InventoryCandidate[];
  models: InventoryCandidate[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function readArray(source: unknown, method: string): unknown[] {
  if (!isRecord(source) || typeof source[method] !== "function") return [];
  try {
    const value = (source[method] as () => unknown).call(source);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function readFirstArray(sources: readonly unknown[], method: string): unknown[] {
  for (const source of sources) {
    if (!isRecord(source) || typeof source[method] !== "function") continue;
    return readArray(source, method);
  }
  return [];
}

function readFirstValue(sources: readonly unknown[], name: string): UnknownRecord | unknown[] | undefined {
  for (const source of sources) {
    if (!isRecord(source)) continue;
    const value = source[name];
    if (Array.isArray(value) || isRecord(value)) return value;
  }
  return undefined;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalize(candidates: InventoryCandidate[]): InventoryCandidate[] {
  const sorted = candidates.sort((left, right) =>
    left.id.localeCompare(right.id) || left.label.localeCompare(right.label) || left.description.localeCompare(right.description)
  );
  return sorted.filter((candidate, index) => index === 0 || candidate.id !== sorted[index - 1].id);
}

function commandCandidates(commands: unknown[]): InventoryCandidate[] {
  const candidates: InventoryCandidate[] = [];
  for (const command of commands) {
    if (!isRecord(command) || command.source !== "skill") continue;
    const id = identifier(command.name);
    if (!id) continue;
    candidates.push({ id, label: id, description: text(command.description), source: "skill" });
  }
  return normalize(candidates);
}

function toolCandidates(tools: unknown[], activeTools: unknown[] | undefined): InventoryCandidate[] {
  const active = activeTools === undefined ? undefined : new Set(activeTools.filter((tool): tool is string => typeof tool === "string"));
  const candidates: InventoryCandidate[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const id = identifier(tool.name);
    if (!id || (active !== undefined && !active.has(id))) continue;
    candidates.push({ id, label: id, description: text(tool.description), source: "tool" });
  }
  return normalize(candidates);
}

function modelId(model: unknown): string | undefined {
  if (!isRecord(model)) return undefined;
  const provider = identifier(model.provider);
  const id = identifier(model.id);
  return provider && id ? `${provider}/${id}` : undefined;
}

function scopedModelIds(scopedModels: unknown): Set<string> | undefined {
  if (!Array.isArray(scopedModels) || scopedModels.length === 0) return undefined;
  const ids = new Set<string>();
  for (const scoped of scopedModels) {
    const model = isRecord(scoped) && scoped.model !== undefined ? scoped.model : scoped;
    const id = modelId(model);
    if (id) ids.add(id);
  }
  return ids;
}

function modelCandidates(registry: unknown, scopedModels: unknown): InventoryCandidate[] {
  const available = readArray(registry, "getAvailable");
  const scoped = scopedModelIds(scopedModels);
  const candidates: InventoryCandidate[] = [];
  for (const model of available) {
    if (!isRecord(model)) continue;
    const id = modelId(model);
    if (!id || (scoped && !scoped.has(id))) continue;
    candidates.push({ id, label: text(model.name, id), description: "", source: "model" });
  }
  return normalize(candidates);
}

/**
 * Captures candidates only from Pi's read-only inventory APIs. The snapshot
 * intentionally excludes path, URL, authentication, and source-detail fields.
 */
export function snapshotInventory(pi: unknown, ctx: unknown): InventorySnapshot {
  const sources = [ctx, pi];
  const commands = readFirstArray(sources, "getCommands");
  const allTools = readFirstArray(sources, "getAllTools");
  const hasActiveTools = sources.some((source) => isRecord(source) && typeof source.getActiveTools === "function");
  const activeTools = hasActiveTools ? readFirstArray(sources, "getActiveTools") : undefined;
  const registry = readFirstValue(sources, "modelRegistry");
  const scopedModels = readFirstValue(sources, "scopedModels");
  return {
    skills: commandCandidates(commands),
    tools: toolCandidates(allTools, activeTools),
    models: modelCandidates(registry, scopedModels),
  };
}

function isCandidate(value: unknown, kind: InventoryKind): value is InventoryCandidate {
  return isRecord(value)
    && value.source === kind
    && typeof value.id === "string"
    && typeof value.label === "string"
    && typeof value.description === "string";
}

/** Recheck a host-selected ID against a fresh snapshot before any host-owned apply step. */
export function validateSelectedCandidate(snapshot: InventorySnapshot, kind: InventoryKind | string, id: string): InventoryCandidate | undefined {
  if ((kind !== "skill" && kind !== "tool" && kind !== "model") || typeof id !== "string") return undefined;
  const candidates = kind === "skill" ? snapshot.skills : kind === "tool" ? snapshot.tools : snapshot.models;
  const candidate = candidates.find((entry) => isCandidate(entry, kind) && entry.id === id);
  return candidate ? { ...candidate } : undefined;
}
