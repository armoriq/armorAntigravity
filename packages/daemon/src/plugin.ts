import type { HookEvent, HookPayload, HookResponse, Mode } from "@armorantigravity/protocol";
import type { Auth, AuthState } from "./auth.ts";
import type { Log } from "./log.ts";
import type { Paths } from "./paths.ts";
import type { Session, SessionStore } from "./sessions.ts";

export interface HookContext {
  readonly id: string;
  readonly receivedAt: number;
  readonly event: HookEvent;
  readonly payload: HookPayload;
  readonly session: Session;
  readonly mode: Mode;
  readonly auth: AuthState;
}

// Runs on the hook path: keep it in memory. Network work belongs in a pump.
export type DecisionHandler = (hook: HookContext) => HookResponse | Promise<HookResponse>;

export type DaemonEvent =
  | { readonly kind: "session_start"; readonly session: Session; readonly at: number }
  | { readonly kind: "turn_start"; readonly session: Session; readonly at: number }
  | { readonly kind: "hook"; readonly hook: HookContext; readonly response: HookResponse; readonly at: number }
  | { readonly kind: "turn_end"; readonly session: Session; readonly at: number }
  | { readonly kind: "session_end"; readonly session: Session; readonly at: number }
  | { readonly kind: "auth"; readonly state: AuthState; readonly at: number };

// Called after the response is written, so it never adds hook latency. Must not throw or block.
export type EventObserver = (event: DaemonEvent) => void;

// A pump starts itself in setup. kick() runs on turn end and when uploads resume; stop() must
// flush what it holds, because the daemon awaits it on shutdown before exiting.
export interface Pump {
  readonly name: string;
  kick(): void;
  stop(): Promise<void>;
}

export interface DaemonContext {
  readonly log: Log;
  readonly paths: Paths;
  readonly auth: Auth;
  readonly sessions: Pick<SessionStore, "get" | "all">;
}

export interface PluginRegistration {
  readonly decide?: DecisionHandler;
  readonly observe?: EventObserver;
  readonly pumps?: readonly Pump[];
}

export interface DaemonPlugin {
  readonly name: string;
  setup(ctx: DaemonContext): PluginRegistration | Promise<PluginRegistration>;
}
