import type { HookPayload, HookResponse, InjectedStep, Surface } from "@armorantigravity/protocol";
import type { IntentRuntime } from "./runtime.ts";

// The parts of the daemon's plugin interface (packages/daemon/src/plugin.ts) this package reads. The daemon's
// HookContext, DaemonEvent and Pump are assignable to these, so the daemon needs no import from here.
export interface IntentHook {
  readonly payload: HookPayload;
  readonly session: { readonly surface: Surface };
}

export interface IntentDaemonEvent {
  readonly kind: string;
  readonly session?: { readonly surface: Surface; readonly conversationId: string };
}

export interface IntentRegistration {
  observe(event: IntentDaemonEvent): void;
  readonly pumps: readonly IntentRuntime["pump"][];
}

// The daemon takes one decision handler, so intent wraps the core's instead of registering its own. observe runs
// before any decision because a subagent's first call must already resolve to its parent's plan.
export function withIntent<H extends IntentHook>(
  runtime: IntentRuntime,
  inner: (hook: H) => HookResponse | Promise<HookResponse>,
): (hook: H) => Promise<HookResponse> {
  return async (hook) => {
    const { payload } = hook;
    const surface = hook.session.surface;
    runtime.observe(surface, payload);
    if (payload.event === "PreToolUse") {
      const own = await runtime.ownToolDecision(surface, payload);
      if (own) return own;
    }
    const response = await inner(hook);
    if (payload.event !== "PreInvocation") return response;
    return withSteps(response, runtime.preInvocation(surface, payload));
  };
}

export function intentRegistration(runtime: IntentRuntime): IntentRegistration {
  return {
    observe(event) {
      if (event.kind !== "session_end" || !event.session) return;
      runtime.conversationEnded({ surface: event.session.surface, conversationId: event.session.conversationId });
    },
    pumps: [runtime.pump],
  };
}

function stepsOf(response: HookResponse): readonly InjectedStep[] | null {
  return response !== null && "injectSteps" in response ? response.injectSteps : null;
}

function withSteps(response: HookResponse, directive: HookResponse): HookResponse {
  const extra = stepsOf(directive);
  if (!extra) return response;
  const own = stepsOf(response);
  if (own) return { injectSteps: [...own, ...extra] };
  return response === null ? directive : response;
}
