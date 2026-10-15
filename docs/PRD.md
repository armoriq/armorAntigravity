# PRD: ArmorAntigravity

Status: draft for review · Owner: Pulkit · Date: 2026-10-12
Product slug (proposed): `armorantigravity` · Agent id: `antigravity`

Sources: Antigravity facts come from `docs/antigravity-research.md`, which cites an official URL for every claim and marks the rest unverified. Parity facts come from four read-only code audits of armorClaude, armorCodex and armorOpenCode `origin/dev`, conmap-auto `origin/dev`, armoriq-tools `origin/main`, the SDK and the other repos, done on 2026-10-12.

---

## 1. Summary

ArmorAntigravity brings ArmorIQ's live intent assurance to Google Antigravity, on every surface it ships:

- **Antigravity 2.0**: the standalone desktop agent app (since 19 May 2026).
- **Antigravity IDE**: the editor, plus the extensions for VS Code, JetBrains, Zed, Visual Studio and Xcode that run the local `agy` backend.
- **Antigravity CLI** (`agy`): closed-source Go, shares the agent engine with 2.0, replaced Gemini CLI for free-tier users on 18 June 2026.

Antigravity has documented hooks that work like Claude Code's. A `PreToolUse` hook can return `deny` with a reason, and the same `~/.gemini/config/hooks.json` applies to all three surfaces (https://antigravity.google/docs/hooks/). So one guard can cover the app, the IDE and the CLI.

It must reach parity with ArmorClaude, ArmorCodex and ArmorOpenCode **including the backend and console surface**. That surface is where ArmorOpenCode v1 fell short and needed 12 follow-up PRs.

## 2. Goals

1. Block any tool call that policy forbids or that drifts from the registered intent plan, on all three surfaces, before it runs.
2. Same evidence as the other plugins: audit rows, plan-to-usage join, per-call token usage, session titles, traces with model and tool spans, turn latency, history backfill.
3. Treated as a first-class product everywhere a product is registered (backend, SDK, console, approval page, admin, landing, docs).
4. Public curl install with prod and dev channels, versioned releases, and the update reminder working from day one.
5. Hook overhead small enough that nobody notices: p95 under 30 ms per tool call (section 6).

## 3. Non-goals for v1

- Cloud-run Antigravity agents. They don't exist yet (research section 1).
- Editor-only extension events (keystrokes, editor commands). Editor extensions have no documented way to observe or block agent tool calls, so the guard lives in hooks.
- Windows on day one. Paths are undocumented and 2.0 on Windows uses an older permission system. Target Windows in v1.1, after a live test.
- Admin-locked enforcement. Antigravity documents no managed or locked hook file, so a user can remove the guard. Section 11 covers this.

## 4. How it differs from ArmorClaude, ArmorCodex and ArmorOpenCode

| | ArmorClaude | ArmorCodex | ArmorOpenCode | **ArmorAntigravity** |
|---|---|---|---|---|
| Host | CLI | CLI | CLI | **Desktop app + IDE + CLI**, one config |
| Interception | `PreToolUse` command hook | `PreToolUse` + `PermissionRequest` hooks | In-process plugin (`tool.execute.before`) | `PreToolUse`/`PostToolUse`/`PreInvocation`/`PostInvocation`/`Stop` command hooks |
| Cost per tool call | ~215 ms (Node start + SDK load) | ~186 ms | 9 µs in-process | Process spawn per call, unavoidable. Design target p95 under 30 ms |
| Intent tool | MCP server | MCP server | Native plugin tool | MCP server, but **the hook captures the plan** (section 5.2) |
| Approval | Native `ask` | Treated as deny | Hold, treated as deny | **Native `ask` / `force_ask`** |
| Usage source | Transcript files | Rollout files | `step-finish` events | Undocumented `transcript.jsonl`, or CLI headless JSON / status line. To be settled in the P0 spike |
| Session id | Claude session id (UUID) | Codex session id (UUID) | `ses_…` (not a UUID) | `conversationId`. Its format is unknown; treat it as non-UUID |

**The core difference is that it's one guard for three surfaces at once.** All three read the same global hooks file, so a single install protects the app, the IDE and the CLI. Each event's `transcriptPath` tells us which surface it came from (`~/.gemini/antigravity/…`, `…/antigravity-cli/…`, `…/antigravity-ide/…`), and we record that surface on every row.

## 4a. Flow parity contract

The auth, intent, token, session and drift flows must match ArmorOpenCode `dev` (29bec8c) exactly, field for field, so the backend and console treat an Antigravity session the same way. The places where ArmorClaude does better are noted. Paths refer to the armorOpenCode repo unless they are marked SDK or CL.

### Auth flow
- **Login command:** `npx -y @armoriq/sdk-dev@<pinned> login --product armorantigravity`, with `ARMORIQ_BACKEND_URL` set by the installer. Bun installs fall back to `bunx`.
- **Device flow** (SDK `cli/commands/auth.ts`):
  - `POST /auth/device/code {product, deviceId, deviceName}`.
  - `verification_uri_complete` must sit on the dashboard origin at `/auth/device`.
  - Poll `POST /auth/device/token {deviceCode}` every `interval` (default 5 s) until `expires_in` (600 s). `authorization_pending` and `slow_down` keep polling.
  - Without `--force`, an existing profile is reused once `GET /iap/sdk/orgs` validates it.
- **Storage:**
  - `~/.armoriq/credentials.json` v2, profile `armorantigravity@<backend host>`, written by temp file and rename, mode 0600, with a lock file.
  - Device id in `~/.armoriq/device-id`.
- **Pickup:**
  - Backend order is `ARMORIQ_BACKEND_URL`, then config, then `https://api.armoriq.ai`. `ARMORIQ_API_KEY` overrides the stored key.
  - The daemon watches the `~/.armoriq` **directory**, not the file, because the SDK replaces it by rename. Debounce is 100 ms; if the directory disappears it falls back to a 10 s poll.
  - The hook path never reads disk.
- **Logout:** `armoriq logout` removes the profile. The watcher sees it and the mode flips to monitor.
- **Header:** `X-ArmorIQ-Client: armorantigravity[-dev]/<version>`. It goes on every audit, usage and trace call, and on SDK calls through the interceptor.
- **Logged out means monitor mode:**
  - every decision is allowed;
  - no audit rows are written;
  - the usage and trace pumps do nothing;
  - plans are kept locally with `id:""`;
  - the intent directive is not injected.
- **Errors:**
  - A 401 on mint means `account_revoked`; a 402 means `billing_blocked`. After either, every non-read-only call is denied.
  - `403 relogin_required` writes the marker `~/.armoriq/armorantigravity/relogin-required-<sha16>`, warns once, and pauses the audit, usage and trace pumps until the key changes.

### Intent flow
- **Tools:**
  - `register_intent_plan{goal?, steps?, plan?, reason?}`. A step is `{action, description?, metadata?:{inputs?}}`, and `tool` is accepted as an alias for `action`.
  - Claude- and OpenCode-style names are mapped to Antigravity names (5.3).
  - Plan hash is sha256 of `{goal, steps}`.
  - Also `trust_reanchor{updatedPlan, reason}`, `trust_revoke{reason}`, `policy_read{tool?}`, plus **`trust_delegate`** (`POST /iap/trust/delegate`, which ArmorClaude has and OpenCode does not).
- **Registration rules:**
  - Subagents are refused.
  - Only one registration may be in flight per conversation.
  - A revision needs a `reason`, with at most 2 per user message (the counter resets on each user message, which is `PreInvocation`).
  - A step the local policy forbids rejects the whole plan.
- **Revision:** `POST /iap/trust/reanchor {newPlan, reason, planId}`, plus a `plan_revision` audit row with `status:"held"` and input `{reason, old_plan_id, old_plan_hash, new_plan_hash, revision, trust_id}`.
- **Check order** (in memory, in the daemon):
  1. built-in rules
  2. ArmorIQ's own tools are allowed
  3. policy forbid or hold
  4. monitor mode → allow
  5. read-only tools skip the plan but honour the backend's denied and held lists
  6. refused token
  7. `intent_plan_missing`
  8. `intent_token_expired`
  9. `intent_drift`
  10. `backend_denied_tool` / held
- **Parameters:** a parameter mismatch is advisory only (`intent_param_mismatch` on the span).
- **`validated:false`:** the backend has no opinion, so empty the denied and held lists. This matches OpenCode, not ArmorCodex (appendix A).

### Token flow
- **Mint:** `POST /iap/sdk/token`.
  - Headers: `X-API-Key`, `Authorization: Bearer`, `X-ArmorIQ-Client`, `Idempotency-Key`.
  - Body: `{user_id, agent_id:"antigravity", context_id:<conversationId>, plan, policy, expires_in:3600}`.
  - **Send the compiled local policy as `policy`, as ArmorClaude does.** OpenCode sends `undefined`.
  - Plan steps carry `mcp:"antigravity"`. Metadata is `source:"antigravity-registered"` and `plan_hash`.
  - Timeout is 5 s with 2 attempts. `plan_id` is required in the response. Expiry comes from `expires_at`; the denied and held lists come from `policy_validation`.
- **Refresh:** a background pump checks every 15 s and re-mints within 60 s of expiry. Backoff is 15 s × 2^(n-1), capped at 5 min. If the plan changed while a mint was in flight, the stale `plan_id` is revoked. A refresh never runs on the hook path.
- **End of session:** `POST /iap/trust/revoke {token, reason, cascade:true, planId}`. Antigravity has no session-deleted event, so revoke after `Stop` plus an idle timeout and when the daemon shuts down (P0 confirms the right trigger).
- **Attachment:** the JWT is held but not sent on later calls; audit rows carry `plan_id`. This is the same as OpenCode.

### Session flow
- **Session id:** `session_id` = `conversationId`, used raw everywhere: audit, usage, traces and `context_id`. Don't swap in a UUID for audit only; that's the OpenCode bug that left session pages showing 0 tokens.
- **Lifecycle:**
  - Start is the first hook for a new `conversationId`.
  - A turn starts with `PreInvocation` (this resets the revision counter) and ends with `PostInvocation`/`Stop`, which kicks the pumps.
  - End is an idle timeout (no `session.deleted` exists).
  - No backend session registration, as in OpenCode.
- **State on disk:** `~/.armoriq/armorantigravity/sessions/<id>.json` (v1, 24 h TTL), keyed by surface plus `conversationId`.
- **Subagents:** link child to root (P0 confirms how subagent steps identify their parent). Checks use the root's plan and token. Audit rows carry the root `session_id` plus `input._antigravity_session=<child>`. Usage rolls up into the root (U6).
- **Titles:** Antigravity's own conversation title, `titleSource:"antigravity-session-title"`, with placeholders skipped.
- **Usage:**
  - `POST /dashboard/token-usage/stream` returns `{generation}`.
  - `POST /dashboard/token-usage/batch {generation, batchId, deviceName, snapshots[], calls[], sessions[]}` with per-session-hour snapshots and per-call records.
  - A 409 generation response means re-initialise and capture again.
  - Sends every 60 s and on idle, with backoff from 5 s to 10 min.
  - Disk: `~/.armoriq/armorantigravity/usage/<hash>/{stream.json, sessions/, queue/, queue/refused/}`.
- **History backfill (from ArmorClaude and ArmorCodex):**
  - `GET /api-keys/device-history-sync?deviceId=` returns `{requestId, requestedAt}`.
  - Discovery and history runs report to `PUT /dashboard/token-usage/runs/<runId>`.

### Drift flow
- **Detection:** no plan step matches the tool.
- **Decision:** `deny`, code `intent_drift`, reason `"<tool> not in plan. Call register_intent_plan with the full updated plan, including this step, and a reason, then retry."`. The hook returns `{decision:"deny", reason:"ArmorIQ blocked this call [intent_drift]: <reason>"}`. Like ArmorClaude, the reason also includes a suggested `register_intent_plan` payload.
- **Monitor mode:** allowed.
- **Audit row:**
  - `status:"blocked"`, `step_index:-1`, `error_message:"intent_drift: <reason>"`.
  - `plan_id` is **omitted** for `intent_drift` and `intent_plan_missing`, so the backend doesn't fail the plan.
  - Rows go through the outbox at `~/.armoriq/armorantigravity/outbox/audit/` to `POST /iap/audit/batch {rows}` (200 rows max, 20 s timeout, dead-letter after 10 attempts or on an `invalid row:` error).
- **Trace:** a policy span `{decision:"block", policyReasonCode:"intent_drift", ruleId?}` under the turn's root span, service `armorantigravity`.
- **Code-change diffs:** none of the existing plugins capture file diffs as their own data. Edit arguments only reach audit and spans as sanitised `input`, truncated to 2000 characters. ArmorAntigravity matches that in v1; a real diff capture would be a separate feature.

## 5. Architecture

```
 Antigravity 2.0 ─┐                       ┌──────────────── armoriq-agd (daemon, one per user) ─────────────────┐
 Antigravity IDE ─┼─ hooks.json ─► agd-hook ┼► unix socket ─► decide() · sessions · plans · tokens               │
 agy CLI ─────────┘   (native, ~ms)         │                pumps: audit · usage · traces · token · history    │──► ArmorIQ backend
                                            │                credentials watcher · policy source + backend sync│
 MCP: register_intent_plan ─────────────────┘└──────────────────────────────────────────────────────────────────┘
```

### 5.1 Hook client plus daemon

- **`agd-hook`** is a small native binary: a Bun-compiled single file or Go, chosen by benchmark in P0. Every hook event runs it. It reads stdin, forwards the event over a unix socket to the daemon, and prints the decision. It loads no SDK and does no network I/O.
- **`armoriq-agd`** is a long-lived daemon, one per user and shared by all three surfaces. It holds:
  - the compiled policy
  - session and plan state
  - intent tokens
  - all upload pumps

  It reuses ArmorOpenCode's TypeScript core (`decide`, `policy`, `intent`, `builtin-rules`, `sanitize`, outbox, pumps) behind an Antigravity adapter. It is not a fresh rewrite.
- **When the daemon isn't running:** the first hook starts it. The hook waits for it up to a budget, then fails **closed** in enforce mode and open in monitor mode, so the guard never depends on Antigravity's own undocumented timeout behavior.
- **Hook timeout:** set an explicit `timeout` in `hooks.json` well above our budget. The default is 30 s.

ArmorClaude's daemon saved only about 15 ms, because its hook still loaded the SDK before calling the daemon. The rule here is that the hook binary must never load the SDK or Node.

### 5.2 Intent plans without the Codex bug

Hooks can't add native tools, so `register_intent_plan` is an MCP tool. MCP calls carry no conversation id. That's what caused ArmorCodex's cross-session plan leak and its fallback minting.

The design: the **`PreToolUse` hook sees the `register_intent_plan` call**, with the plan in its args and the `conversationId` in the event. The hook registers the plan in the daemon keyed by `conversationId`, and the daemon mints the token. The MCP server only acknowledges the call, and does so after the hook has recorded the plan.

Plan rules copied from ArmorOpenCode:
- Plans narrow what policy allows; they never widen it.
- A revision needs a reason, at most 2 per user message, and each revision writes an audit row.
- Subagents inherit the root's plan and can't register their own.
- With no plan, side-effecting tools are denied in enforce mode. There is no fallback mint from the tool call.

`PreInvocation` can inject steps (https://antigravity.google/docs/hooks/). Use it to inject the "register a plan first" reminder or a forced `register_intent_plan` call, and keep `~/.gemini/config/rules/armoriq.md` (`trigger: always_on`) as the base instruction.

### 5.3 Tool mapping

Documented tool names map to policy actions:

| Antigravity tools | Policy action |
|---|---|
| `run_command` | shell |
| `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `notebook_edit` | write/edit |
| `view_file`, `list_dir`, `find_by_name`, `grep_search` | read-only |
| `search_web`, `read_url_content` | web |
| `invoke_subagent`, `define_subagent`, `send_message`, `manage_subagents` | subagent |
| `browser_*` | browser |
| `call_mcp_tool` | MCP. Server and tool are parsed from args; confirm the shape in P0 |

Map ArmorClaude's names (`Bash`, `Edit`, `mcp__s__t`) the same way ArmorOpenCode does, so a policy works across products.

## 6. Latency budget

| Hook | p50 / p95 target | What's in it |
|---|---|---|
| `PreToolUse` | 8 ms / 30 ms | Process start, socket round trip, memory-only `decide` |
| `PostToolUse` | 8 ms / 30 ms | Queue the audit row and trace event; no network |
| `PreInvocation` / `Stop` | 15 ms / 50 ms | Turn bookkeeping and kicking the upload pumps |

Measured in CI with a real `agy` against a stub model and a stub backend, the same way ArmorOpenCode's `bench/` gates CI today. A budget is enforced only on hooks with at least 20 samples. That rule exists because of a flaky gate we hit before. GitHub's hosted macOS runners spawn processes too slowly to meet these targets even for the bare spawn and socket round trip, so CI holds them to a separate runner budget recorded with its measurements in `packages/hook/bench/latency.ts`; Linux runners and local runs use the targets above.

## 7. Requirements

The "Reference" column says which plugin to copy. The bold rows are the ones ArmorOpenCode missed in v1 and fixed later, or still hasn't fixed.

### 7.1 Enforcement

| # | Requirement | Reference |
|---|---|---|
| E1 | Deny before the tool runs, with a reason the agent can act on | Claude / OpenCode |
| E2 | Policy IR with permit / forbid / require_approval, deny wins, `default-hold` | OpenCode `core/policy.ts` |
| E3 | **Pull the backend policy at session start** (`GET /policies/profiles/active`), local file as fallback | **Claude**. OpenCode lacks it |
| E4 | Built-in protections: block read and write of `~/.armoriq`, and **writes to the guard's own files** (`~/.gemini/config/hooks.json`, `rules/armoriq.md`, `mcp_config.json`, plugin dir) | OpenCode, plus new for Antigravity |
| E5 | **Shell lexer**: split compound and wrapped commands; don't judge on the first word only | **Claude `shell-guard.mjs`**. OpenCode lacks it |
| E6 | **Approval through the native prompt**: `require_approval` and backend `held_tools` return `ask` / `force_ask` | **Claude**. OpenCode and Codex deny |
| E7 | **MCP deny-by-default server gate**: an unknown MCP server asks first; register servers with the backend (`/mcp/auto-register`, `/mcp/servers`) | **Claude**. OpenCode lacks it |
| E8 | Monitor mode when logged out, enforce when logged in; an internal error denies in enforce | OpenCode / Claude |
| E9 | Treat `validated:false` from the plan check as "no opinion" | **OpenCode**. Codex has a bug here (appendix A) |
| E10 | Respect backend `denied_tools` and `held_tools` | OpenCode |
| E11 | Browser and subagent steps are covered if hooks fire for them; if not, document it clearly | New, P0 spike |
| E12 | **Send the policy with the mint** so the backend doesn't fall back to `allow *` | **Claude / Codex**. OpenCode sends `undefined` |

### 7.2 Intent

| # | Requirement | Reference |
|---|---|---|
| I1 | `register_intent_plan`, `trust_reanchor`, `trust_revoke`, **`trust_delegate`** | Claude has all four; OpenCode lacks delegate |
| I2 | **Mint with `contextId` = the raw Antigravity `conversationId`** | **OpenCode #102** (missed in v1) |
| I3 | Token refreshed in the background before expiry, with backoff; revoked with cascade at session end | OpenCode |
| I4 | Drift is denied with `intent_drift`, and the denial is audited without a plan id | OpenCode |
| I5 | 401 means revoked, 402 means billing: deny side-effecting calls, keep local policy | OpenCode / Claude |
| I6 | Capture plans from Antigravity's planning mode or artifacts if they exist | Claude's ExitPlanMode capture. Check in P0 |

### 7.3 Audit (`POST /iap/audit/batch`)

| # | Requirement | Reference |
|---|---|---|
| A1 | Row shape matches the DTO: object `input` and `output`, `step_index`, `duration_ms`, `executed_at`, status including `held` | OpenCode |
| A2 | Attribution: `session_id` = `conversationId`, `agent_id` = `antigravity`, `client_id` = `armorantigravity`, `user_id`, `user_email`, plus the surface in input metadata | OpenCode |
| A3 | **`client_row_id` UUID on every row**, so a resend can't duplicate | **Codex**. Claude and OpenCode lack it |
| A4 | Honor per-row `failures[]`: dead-letter `invalid row:` rows, retry the rest up to 10 times, and treat a 2xx with no `failures` key as a failed send | **OpenCode**. Claude and Codex drop rows (appendix A) |
| A5 | Durable outbox, wait for in-flight sends at shutdown, jittered backoff, honor Retry-After | OpenCode (#57, #79 fixes) |
| A6 | 2000-character redaction and truncation | OpenCode / Claude |

### 7.4 Usage

| # | Requirement | Reference |
|---|---|---|
| U1 | Stream and batch protocol through the SDK: generations, 409 recapture, acks per generation | All three |
| U2 | **A record for every model call in the batch** (`calls`) | **OpenCode #103** (missed in v1) |
| U3 | **Session titles** with a new source `antigravity-session-title`, Antigravity's own title only, never prompt text, placeholders skipped | **OpenCode #123** (missed in v1). Needs backend, SDK and console registration (section 8) |
| U4 | **History backfill** through `GET /api-keys/device-history-sync`, plus `reportUsageRun` | **Claude / Codex**. OpenCode still lacks it |
| U5 | **Turn latency** through `recordTokenLatency` | **Claude / Codex**. OpenCode still lacks it. Needs an SDK extractor |
| U6 | Subagent usage goes into the root session, so the plan's usage is complete | **OpenCode #100**, still open; do it right from the start |
| U7 | Correct repo field (no `/` outside a git repo) and device name | OpenCode #116 and #117, still open |
| U8 | Source of token counts: decided in the P0 spike (`transcript.jsonl` vs CLI headless JSON vs status line). Hooks receive no token counts | New |

### 7.5 Traces (lease plus `POST /v1/traces`)

| # | Requirement | Reference |
|---|---|---|
| T1 | A **`gen_ai.chat` span for every model step** (`recordUsageCallSpans`) | **OpenCode #120** (missed; the console showed 0 tokens) |
| T2 | Decision spans with allow / block / hold, reason code and rule id | OpenCode |
| T3 | **Tool spans with `durationMs`**, and MCP tools categorized as `mcp` | **Claude**. OpenCode lacks both |
| T4 | **`agentId` on the root span** | **Claude / Codex**. OpenCode lacks it |
| T5 | **Durable trace spool** with retry, so traces survive a one-shot `agy` run that exits immediately | **Claude**. OpenCode loses them (#118) |
| T6 | Cost and `gen_ai.system` set correctly for Gemini model ids | OpenCode #121, still open |

### 7.6 Identity, versioning and release

| # | Requirement | Reference |
|---|---|---|
| R1 | Device login `--product armorantigravity`, profile `armorantigravity@<host>` | All |
| R2 | **`X-ArmorIQ-Client: armorantigravity[-dev]/<semver>` on every request**, with the `-dev` channel for dev installs | **Claude / Codex**. OpenCode lacks `-dev` |
| R3 | **A real GitHub release before launch**: CHANGELOG sections, a `v*` tag, and a release workflow that **runs tests** and gates on a label | **Claude / Codex**. OpenCode has never released, and its workflow runs no tests |
| R4 | **Backend `PLUGIN_RELEASES` entry with stable and dev channels** | **Claude / Codex**. OpenCode is stable-only |
| R5 | The installer installs the newest release tag; dev installs `dev` | OpenCode #109 |
| R6 | **Pin the newest SDK** that has every option used (`contextId`, `calls`, `client`, title source) | **OpenCode #101** |

### 7.7 Installer

| # | Requirement |
|---|---|
| N1 | `curl -fsSL https://armoriq.ai/install_armorantigravity.sh \| bash` (prod) and `_dev.sh` (staging), as thin wrappers on the landing site that fetch the repo's own installer. Plus `uninstall_armorantigravity.sh`. |
| N2 | **Merge** into existing `~/.gemini/config/hooks.json` and `mcp_config.json` instead of overwriting them. `mcp_config.json` accepts comments and trailing commas, so a strict JSON parser won't work. Write `~/.gemini/config/rules/armoriq.md`. |
| N3 | Also offer `agy plugin install https://github.com/armoriq/armorAntigravity` for CLI users, and the `~/.gemini/config/plugins/armoriq/` folder for 2.0 and the IDE (P0: confirm 2.0 and the IDE load plugin hooks; the docs disagree). |
| N4 | Install and start the daemon (a launchd agent on macOS, a systemd user unit on Linux); uninstall removes them; `--purge` also removes data and keeps the login. |
| N5 | Detect which surfaces are installed (2.0 app, IDE, `agy`) and report each one in the final summary. |
| N6 | Installer tests in the repo, plus landing's `installer-checks.yml` and `test-installer-*.sh` covering the new wrappers. |

## 8. Product registration checklist (every place a slug must exist)

Taken from today's sweep. Each line is an acceptance item; ArmorOpenCode missed several of them.

- **conmap-auto:**
  - `PRODUCT_SLUGS`, `TOOL_PRODUCTS` and `TOOL_PRODUCT_AGENT_NAMES` (`src/common/products.ts`)
  - device-history-sync DTO
  - `PRODUCT_TOOL_PRODUCTS`, `PRODUCT_ORDER`, `BILLABLE_PRODUCTS`
  - agent classifier (`antigravity` → `armorantigravity`)
  - `TITLE_SOURCES` (+ `antigravity-session-title`)
  - **`PLUGIN_RELEASES` stable + dev**
  - SQL chat prompt
  - Prisma CHECK constraints migration (usage_streams, device_history_syncs)
- **SDK:**
  - `TOOL_PRODUCTS`, CLI `--product` help
  - `titleSource` union and `TITLE_SOURCES`
  - **a title reader** and **a turn-latency extractor** for Antigravity (OpenCode has neither)
- **Console (armoriq-tools):**
  - every enumeration: `AGENT_PRODUCTS`, product types, setup install commands, harness keys, labels, colors, icons, scopes, filters, tabs, chat words, home cards, graph labels, runtime evidence
  - **the analytics upload banner scope** (OpenCode missing)
  - **the docs "supported producers" table** (OpenCode missing)
  - the `tokenstat` harness map (OpenCode missing)
- **armorIQ-platform-proto:**
  - device-approval `TOOL_PRODUCTS` and display label
  - **`ProductSlugSchema`** (OpenCode missing; it has already drifted)
  - wizard and session copy
- **armoriq-admin:** product type, routes, nav.
- **armorIQ-landing:**
  - prod, dev and uninstall wrappers
  - product page and content
  - nav, footer, sitemap, SEO, support form
  - **brand kit, README route table, privacy-policy disclosures, installer CI** (OpenCode missing all of these)
- **armoriq-docs:** product catalog, content dirs, loaders, rewrites, index.json and llms.txt ids, manifest schema, glossary, observability page, quickstart (OpenCode has **no docs at all**).

## 9. Phases

Each phase ends with proof from a real run, not just green CI.

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0: spike, 2 to 3 days** | Install all three surfaces. Settle the 7 unknowns (section 10). Benchmark the hook process in Bun vs Go. Choose the usage source. | Written answers to each unknown with evidence; a go or no-go per surface |
| P1: guard core | `agd-hook` + daemon, shared core from OpenCode, E1–E12 enforcement, the shell lexer, native `ask` | Real `agy` and 2.0 sessions: in-plan allowed, off-plan blocked, guard files protected; latency budget green in CI |
| P2: intent | I1–I6, plan captured by the hook, contextId | A plan in the console shows that session's tokens |
| P3: evidence | A1–A6, U1–U8, T1–T6 | Staging console shows titles, per-call usage, model spans, tool durations, latency and history backfill for an Antigravity session |
| P4: platform | Section 8 checklist across all repos, R1–R6, backend release channels | Update reminder fires in staging for a dev install |
| P5: ship | Installer N1–N6, landing pages, docs, first `v0.1.0` release, launch checklist | The public dev curl command works for a fresh user; the prod command waits on the backend reaching prod (appendix B) |

Each PR stays under the 1,000-line org cap, stacked bottom-up into `dev`, then promoted to `main`. That avoids the stack collapse that happened on OpenCode.

## 10. Unknowns for the P0 spike (from the research)

1. The hook `toolCall.name` and `args` shape for MCP calls (`call_mcp_tool`?).
2. Whether `PreToolUse` fires for subagent and browser-subagent steps.
3. Whether a hook timeout or crash fails open or closed. Until proven, assume open, and get closed behavior through our own client-side budget.
4. Whether the `deny` reason reaches the model.
5. The `transcript.jsonl` schema: does it carry per-step tokens and model ids, for usage and history?
6. Whether 2.0 and the IDE extensions honor plugin-level hooks and the global `mcp_config.json`.
7. Whether `--dangerously-skip-permissions` also skips hooks.

## 11. Risks

| Risk | Mitigation |
|---|---|
| A user deletes the guard's hooks (no admin lock exists) | Guard files are write-protected through hooks while a session runs (E4). Heartbeat from the daemon; the console flags a device that stopped reporting. Ask Google for a managed setting. |
| Hook fires per process, costing latency | Native hook client + daemon (5.1); CI latency gate (6) |
| Browser or subagent steps aren't covered | P0 decides; if not covered, deny `invoke_subagent` and `browser_subagent` in enforce mode unless policy allows them, and document it |
| No token counts in hooks | Read `transcript.jsonl` or CLI JSON (U8); history backfill covers the gaps |
| Closed-source CLI changes behavior | Pin the tested `agy` version in CI; run an e2e check against the newest `agy` every night |
| Prod backend is behind dev | Same as OpenCode today (appendix B): the launch needs conmap `dev` deployed to production |

## 12. Success metrics

- 100% of side-effecting tool calls on supported surfaces go through `decide`. Measured by audit rows vs transcript steps in the e2e run.
- Hook overhead p95 under 30 ms in CI and on a dev laptop.
- An Antigravity session on the staging console shows its title, tokens (per call and per hour), model spans, tool durations, plans with usage, and blocked drift. No "0 → 0" and no bare ids.
- Zero follow-up PRs needed for parity after launch. That's the lesson from OpenCode's 12.

## 13. Decisions needed from you

1. **Name and slug:** `ArmorAntigravity` / `armorantigravity`?
2. **Surfaces for v1:** all three (recommended, since one hooks file covers them) or the CLI first?
3. **Default mode when logged in:** enforce (like OpenCode) or monitor (like ArmorClaude's drift default)?
4. **Whether to fix the existing plugins first** (appendix A), so all four behave the same.

---

## Appendix A: bugs in the existing plugins found while writing this

| Plugin | Issue | Effect |
|---|---|---|
| ArmorCodex | Enforces `planCheck.deniedTools` without checking `validated` (ArmorClaude does not read `planCheck` at all) | For an org with no policy, the backend lists every tool as denied, so Codex blocks everything |
| ArmorClaude, ArmorCodex | Ignore per-row `failures[]` from `/iap/audit/batch`; no dead letter; whole-batch retry with no backoff | Rejected or deferred audit rows are silently lost |
| ArmorClaude, ArmorCodex | Never send `held` audit rows | Approvals aren't visible in the console |
| ArmorClaude | No `client_row_id` | Resends can duplicate rows |
| ArmorCodex | No revoke, reanchor or refresh; enforce by default even when logged out; read-only tools skip policy; drift deny has no reason code | Weaker than the others |
| ArmorClaude | Session-end revoke uses `cascade:false`; a 402 allows with a notice instead of blocking; defaults to the staging backend | Delegated tokens outlive the session; billing block not enforced |
| ArmorOpenCode | No release ever published; `main` is 13 commits behind `dev`; prod installer serves outdated `main` | Update reminder can't fire; prod users get old code |
| ArmorOpenCode | No history backfill, turn latency, `-dev` client channel, tool span durations, root `agentId`, durable trace spool, `client_row_id`, backend policy sync, shell lexer, MCP server gate, native approval; sends no policy with the mint | Parity gaps listed in section 7 |
| ArmorOpenCode | No docs site entry; platform-proto `ProductSlugSchema`, console upload banner, landing brand kit and privacy policy missing it | Registration gaps (section 8) |

## Appendix B: prod backend dependency

Production (`api.armoriq.ai`) runs conmap-auto `main`, 807 commits behind `dev`. It rejects the login's `deviceId`, and it lacks the usage stream, the trace lease and the newer title sources. Every new plugin, ArmorAntigravity included, needs `dev` promoted to production (https://github.com/armoriq/conmap-auto/pull/1134) before its prod curl command can work.
