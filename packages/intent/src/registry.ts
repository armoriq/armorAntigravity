import { conversationKey, type ConversationKey, type ConversationRef, type Plan, type Token } from "./types.ts";

export interface Conversation {
  readonly key: ConversationKey;
  readonly ref: ConversationRef;
  readonly parent: ConversationKey | null;
  readonly plan: Plan | null;
  readonly token: Token | null;
  readonly stepCursor: number;
  readonly turn: number;
  readonly revisionsThisTurn: number;
  readonly lastActivity: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface Registry {
  open(ref: ConversationRef): Conversation;
  has(key: ConversationKey): boolean;
  get(key: ConversationKey): Conversation | null;
  // A subagent resolves to the conversation that holds the plan; everything else resolves to itself.
  root(key: ConversationKey): Conversation | null;
  link(child: ConversationRef, parent: ConversationRef): boolean;
  beginTurn(key: ConversationKey): void;
  setPlan(key: ConversationKey, plan: Plan, token: Token | null): void;
  setToken(key: ConversationKey, token: Token): void;
  clearPlan(key: ConversationKey): void;
  noteRevision(key: ConversationKey): void;
  advance(key: ConversationKey, stepIndex: number): void;
  close(key: ConversationKey): void;
  all(): Iterable<Conversation>;
}

export function createRegistry(now: () => number = Date.now): Registry {
  const conversations = new Map<ConversationKey, Mutable<Conversation>>();

  const open = (ref: ConversationRef): Mutable<Conversation> => {
    const key = conversationKey(ref);
    const existing = conversations.get(key);
    if (existing) {
      existing.lastActivity = now();
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
      lastActivity: now(),
    };
    conversations.set(key, created);
    return created;
  };

  const resolve = (key: ConversationKey): Mutable<Conversation> | null => {
    let current = conversations.get(key) ?? null;
    for (let hops = 0; current?.parent && hops < 16; hops++) current = conversations.get(current.parent) ?? null;
    return current;
  };

  const update = (key: ConversationKey, apply: (c: Mutable<Conversation>) => void) => {
    const c = conversations.get(key);
    if (c) apply(c);
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
      return true;
    },

    beginTurn: (key) =>
      update(key, (c) => {
        c.turn += 1;
        c.revisionsThisTurn = 0;
        c.lastActivity = now();
      }),

    setPlan: (key, plan, token) =>
      update(key, (c) => {
        c.plan = plan;
        c.token = token;
        c.stepCursor = 0;
      }),

    setToken: (key, token) =>
      update(key, (c) => {
        c.token = token;
      }),

    clearPlan: (key) =>
      update(key, (c) => {
        c.plan = null;
        c.token = null;
        c.stepCursor = 0;
      }),

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
      for (const c of conversations.values()) if (c.parent === key) c.parent = null;
    },

    all: () => conversations.values(),
  };
}
