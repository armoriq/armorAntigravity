import type { QueueLogin, SendResult } from "@armorantigravity/core";
import type { EvidenceDeps } from "../context.ts";
import { auditLogin } from "../pumps/audit.ts";
import { authHeaders } from "./http.ts";

export type ReportingResult<T> = SendResult<T>;

export function reportingDelivery(deps: EvidenceDeps) {
  return {
    async probe(binding: QueueLogin): Promise<boolean> {
      const login = deps.uploads.probeLogin ? deps.uploads.probeLogin() : deps.uploads.login();
      const identity = auditLogin(login);
      if (!login || identity?.backend !== binding.backend || identity.keyId !== binding.keyId) return false;
      const response = await fetch(`${login.backend}/iap/validate-key`, { method: "POST", headers: authHeaders(login, deps.uploads), body: "{}", signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      const valid = response.status >= 200 && response.status < 300;
      if (valid) deps.uploads.authenticationSucceeded?.(login);
      return valid;
    },
  };
}
