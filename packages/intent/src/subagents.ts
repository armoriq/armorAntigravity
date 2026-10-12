import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry.ts";
import { conversationKey, type ConversationKey, type ConversationRef } from "./types.ts";

const SPAWN_WINDOW_MS = 10 * 60_000;

// Observed in the spike capture (agy CLI, P0 #3): a subagent runs as a new conversationId with no parent field
// in its payloads. The parent's artifact directory gains .system_generated/subagents/<childId>.json, written in
// the same second as the child's first hook, and the child's send_message names the parent as Recipient.
// So the link is looked up on every event of an unlinked conversation until it resolves.
export interface SubagentLinker {
  noteEvent(ref: ConversationRef, artifactDirectoryPath: string | undefined): void;
  noteSpawn(parent: ConversationRef, at: number): void;
  noteMessage(child: ConversationRef, recipient: string): void;
  // Links `ref` to its parent if the evidence exists now. Cheap when there is no recent spawn.
  resolve(ref: ConversationRef): void;
  // True for a conversation first seen after a recent spawn on its surface that is not yet resolved either way.
  mightBeChild(ref: ConversationRef): boolean;
}

export function createSubagentLinker(registry: Registry, now: () => number = Date.now, exists: (path: string) => boolean = existsSync): SubagentLinker {
  const artifactDirs = new Map<ConversationKey, string>();
  const spawns = new Map<ConversationKey, { ref: ConversationRef; at: number }>();
  const settled = new Set<ConversationKey>();
  const firstSeen = new Map<ConversationKey, number>();

  const settle = (key: ConversationKey) => {
    settled.add(key);
  };

  return {
    noteEvent(ref, dir) {
      const key = conversationKey(ref);
      if (!firstSeen.has(key)) firstSeen.set(key, now());
      if (dir) artifactDirs.set(key, dir);
    },

    noteSpawn(parent, at) {
      spawns.set(conversationKey(parent), { ref: parent, at });
    },

    noteMessage(child, recipient) {
      const key = conversationKey(child);
      if (settled.has(key)) return;
      const parent = { surface: child.surface, conversationId: recipient };
      if (registry.has(conversationKey(parent)) && registry.link(child, parent)) settle(key);
    },

    mightBeChild(ref) {
      const key = conversationKey(ref);
      if (settled.has(key)) return false;
      const seen = firstSeen.get(key) ?? now();
      for (const [parentKey, spawn] of spawns) {
        if (parentKey !== key && spawn.ref.surface === ref.surface && spawn.at <= seen && seen - spawn.at <= SPAWN_WINDOW_MS) return true;
      }
      return false;
    },

    resolve(ref) {
      const key = conversationKey(ref);
      if (settled.has(key)) return;
      const self = registry.get(key);
      if (self?.parent || self?.plan) return settle(key);
      const cutoff = now() - SPAWN_WINDOW_MS;
      for (const [parentKey, spawn] of spawns) {
        if (spawn.at < cutoff) {
          spawns.delete(parentKey);
          continue;
        }
        if (parentKey === key || spawn.ref.surface !== ref.surface) continue;
        const dir = artifactDirs.get(parentKey);
        if (dir && exists(join(dir, ".system_generated", "subagents", `${ref.conversationId}.json`)) && registry.link(ref, spawn.ref)) {
          return settle(key);
        }
      }
    },
  };
}
