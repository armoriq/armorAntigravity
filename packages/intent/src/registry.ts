import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { conversationKey, type ConversationKey, type ConversationRef, type Draft, type Login, type Mode, type Plan, type Token } from "./types.ts";

export type PlanKind = "new" | "revision" | "refresh";

export interface PendingRequest {
  readonly key: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface Generation {
  readonly conversation: Conversation;
  readonly promptGeneration: number;
  readonly authGeneration: number;
}

export interface Conversation {
  readonly key: ConversationKey;
  readonly ref: ConversationRef;
  readonly parent: ConversationKey | null;
  readonly plan: Plan | null;
  readonly token: Token | null;
  readonly stepCursor: number;
  readonly turn: number;
  readonly revisionsThisTurn: number;
  readonly promptId: string | null;
  readonly promptGeneration: number;
  readonly promptOpenSince: number | null;
  readonly lastActivityAt: number;
  readonly countedPlanId: string | null;
  readonly tokenPlanId: string | null;
  readonly planHash: string | null;
  readonly kind: PlanKind | null;
  readonly tokenExpiresAt: number | null;
  readonly authGeneration: number;
  readonly pendingRequest: PendingRequest | null;
  readonly unregisteredLocalPlan: Draft | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface Registry {
  open(ref: ConversationRef): Conversation;
  has(key: ConversationKey): boolean;
  get(key: ConversationKey): Conversation | null;
  // A subagent resolves to the conversation that holds the plan; everything else resolves to itself.
  root(key: ConversationKey): Conversation | null;
  link(child: ConversationRef, parent: ConversationRef): boolean;
  beginPrompt(key: ConversationKey, initialNumSteps: number): void;
  endPrompt(key: ConversationKey): void;
  syncAuth(login: Login | null, mode: Mode): void;
  generation(key: ConversationKey): Generation | null;
  isCurrent(key: ConversationKey, generation: Generation): boolean;
  acquire(key: ConversationKey): (() => void) | null;
  busy(key: ConversationKey): boolean;
  setPlan(key: ConversationKey, plan: Plan, token: Token | null, generation?: Generation, kind?: PlanKind): boolean;
  setToken(key: ConversationKey, token: Token, generation?: Generation, tokenPlanId?: string): boolean;
  setPendingRequest(key: ConversationKey, request: PendingRequest | null, generation: Generation): boolean;
  clearPlan(key: ConversationKey): void;
  noteRevision(key: ConversationKey): void;
  advance(key: ConversationKey, stepIndex: number): void;
  close(key: ConversationKey): void;
  all(): Iterable<Conversation>;
}

export function createRegistry(now: () => number = Date.now, stateFile?: string): Registry {
  const conversations = new Map<ConversationKey, Mutable<Conversation>>();
  const promptIdentities = new Map<ConversationKey, Set<number>>();
  const operations = new Map<ConversationKey, symbol>();
  let authIdentity: string | undefined;

  if (stateFile) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, "utf8"));
      if (saved.v !== 1 || !Array.isArray(saved.conversations) || typeof saved.authIdentity !== "string") throw new Error("invalid intent state");
      authIdentity = saved.authIdentity;
      for (const entry of saved.conversations) {
        const c = entry.conversation as Mutable<Conversation>;
        if (!c.ref || c.key !== conversationKey(c.ref) || !Number.isInteger(c.promptGeneration) || !Number.isInteger(c.authGeneration)) throw new Error("invalid conversation state");
        if (c.token?.status === "active") c.token = { ...c.token, deniedTools: new Set(c.token.deniedTools), heldTools: new Set(c.token.heldTools) };
        conversations.set(c.key, c);
        promptIdentities.set(c.key, new Set(entry.identities));
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  const persist = () => {
    if (!stateFile) return;
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    const data = { v: 1, authIdentity, conversations: [...conversations.values()].map(c => ({
      conversation: { ...c, token: c.token?.status === "active" ? { ...c.token, deniedTools: [...c.token.deniedTools], heldTools: [...c.token.heldTools] } : c.token },
      identities: [...(promptIdentities.get(c.key) ?? [])],
    })) };
    const tmp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, stateFile);
  };

  const touch = (c: Mutable<Conversation>) => {
    const root = resolve(c.key);
    if (root?.promptOpenSince !== null && root && now() - root.lastActivityAt >= 30 * 60_000) root.promptOpenSince = null;
    c.lastActivityAt = now();
    if (root && root !== c) root.lastActivityAt = c.lastActivityAt;
    persist();
  };

  const open = (ref: ConversationRef): Mutable<Conversation> => {
    const key = conversationKey(ref);
    const existing = conversations.get(key);
    if (existing) {
      touch(existing);
      return existing;
    }
    const created: Mutable<Conversation> = {
      key,
      ref: { surface: ref.surface, conversationId: ref.conversationId },
      parent: null,
      plan: null,
      token: null,
      stepCursor: 0,
      turn: 0,
      revisionsThisTurn: 0,
      promptId: null,
      promptGeneration: 0,
      promptOpenSince: null,
      lastActivityAt: now(),
      countedPlanId: null,
      tokenPlanId: null,
      planHash: null,
      kind: null,
      tokenExpiresAt: null,
      authGeneration: 0,
      pendingRequest: null,
      unregisteredLocalPlan: null,
    };
    conversations.set(key, created);
    persist();
    return created;
  };

  const resolve = (key: ConversationKey): Mutable<Conversation> | null => {
    let current = conversations.get(key) ?? null;
    for (let hops = 0; current?.parent && hops < 16; hops++) current = conversations.get(current.parent) ?? null;
    return current;
  };

  const update = (key: ConversationKey, apply: (c: Mutable<Conversation>) => void) => {
    const c = conversations.get(key);
    if (c) {
      apply(c);
      persist();
    }
  };

  const retire = (c: Mutable<Conversation>) => {
    c.plan = null;
    c.token = null;
    c.stepCursor = 0;
    c.countedPlanId = null;
    c.tokenPlanId = null;
    c.planHash = null;
    c.kind = null;
    c.tokenExpiresAt = null;
    c.pendingRequest = null;
    c.unregisteredLocalPlan = null;
  };

  const isCurrent = (key: ConversationKey, generation: Generation) => {
    const c = conversations.get(key);
    return c === generation.conversation && c.promptGeneration === generation.promptGeneration && c.authGeneration === generation.authGeneration;
  };

  return {
    open,
    has: (key) => conversations.has(key),
    get: (key) => conversations.get(key) ?? null,
    root: resolve,

    link(childRef, parentRef) {
      const child = open(childRef);
      const parent = open(parentRef);
      // A conversation that already registered its own plan is a root, and a link must never form a cycle.
      if (child.key === parent.key || child.plan !== null || resolve(parent.key)?.key === child.key) return false;
      child.parent = parent.key;
      persist();
      return true;
    },

    beginPrompt: (key, initialNumSteps) =>
      update(key, (c) => {
        if (c.parent !== null || promptIdentities.get(key)?.has(initialNumSteps)) return;
        const identities = promptIdentities.get(key) ?? new Set<number>();
        identities.add(initialNumSteps);
        promptIdentities.set(key, identities);
        retire(c);
        c.promptId = randomUUID();
        c.promptGeneration += 1;
        c.promptOpenSince = now();
        c.lastActivityAt = now();
        c.turn += 1;
        c.revisionsThisTurn = 0;
        touch(c);
      }),

    endPrompt: (key) =>
      update(key, (c) => {
        if (c.parent === null) c.promptOpenSince = null;
      }),

    syncAuth(login, mode) {
      const identity = createHash("sha256").update(JSON.stringify([mode, login?.backend, login?.apiKey, login?.userId, login?.orgId])).digest("hex");
      if (identity === authIdentity) return;
      if (authIdentity !== undefined) for (const c of conversations.values()) {
        if (c.parent !== null) continue;
        c.authGeneration += 1;
        retire(c);
      }
      authIdentity = identity;
      persist();
    },

    generation(key) {
      const c = conversations.get(key);
      return c ? { conversation: c, promptGeneration: c.promptGeneration, authGeneration: c.authGeneration } : null;
    },

    isCurrent,

    acquire(key) {
      if (operations.has(key)) return null;
      const owner = Symbol();
      operations.set(key, owner);
      return () => { if (operations.get(key) === owner) operations.delete(key); };
    },

    busy: (key) => operations.has(key),

    setPlan(key, plan, token, generation, kind) {
      const c = conversations.get(key);
      if (!c || generation && !isCurrent(key, generation)) return false;
      const revising = c.countedPlanId !== null;
      c.plan = plan;
      c.token = token;
      c.stepCursor = 0;
      c.countedPlanId = kind === "refresh" ? c.countedPlanId : plan.id || null;
      c.tokenPlanId = token?.status === "active" ? plan.id || null : null;
      c.planHash = plan.hash;
      c.kind = plan.id ? kind ?? (revising ? "revision" : "new") : null;
      c.tokenExpiresAt = token?.status === "active" ? token.expiresAt : null;
      c.pendingRequest = null;
      c.unregisteredLocalPlan = plan.id ? null : plan;
      persist();
      return true;
    },

    setToken(key, token, generation, tokenPlanId) {
      const c = conversations.get(key);
      if (!c || generation && !isCurrent(key, generation)) return false;
      c.token = token;
      c.tokenPlanId = token.status === "active" ? tokenPlanId ?? (c.plan?.id || null) : null;
      c.tokenExpiresAt = token.status === "active" ? token.expiresAt : null;
      persist();
      return true;
    },

    setPendingRequest(key, request, generation) {
      const c = conversations.get(key);
      if (!c || !isCurrent(key, generation)) return false;
      c.pendingRequest = request;
      persist();
      return true;
    },

    clearPlan: (key) => update(key, retire),

    noteRevision: (key) =>
      update(key, (c) => {
        c.revisionsThisTurn += 1;
      }),

    advance: (key, stepIndex) =>
      update(key, (c) => {
        c.stepCursor = Math.max(c.stepCursor, stepIndex + 1);
      }),

    close: (key) => {
      conversations.delete(key);
      promptIdentities.delete(key);
      for (const c of conversations.values()) if (c.parent === key) c.parent = null;
      persist();
    },

    all: () => conversations.values(),
  };
}
