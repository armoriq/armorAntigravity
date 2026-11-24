export type { Auth, AuthState, Login, Refusal } from "./auth.ts";
export { AlreadyRunning, RestartRequired, startDaemon, type DaemonOptions, type RunningDaemon } from "./daemon.ts";
export type { Log } from "./log.ts";
export type { Paths } from "./paths.ts";
export type { DaemonContext, DaemonEvent, DaemonPlugin, DecisionHandler, EventObserver, HookContext, McpOutcomeHandler, PluginRegistration, Pump } from "./plugin.ts";
export type { Session } from "./sessions.ts";
export { prepareHookCapture, auditStatus } from "./capture.ts";
export { sessionKey, surfaceFromTranscriptPath, type SessionKey } from "./surface.ts";
export { createUpdater, NO_AUTO_UPDATE_ENV, optedOut, readUpdateStatus, RESTART_EXIT_CODE, type CheckResult, type Updater, type UpdateStatus } from "./update.ts";
