import { loadProfile, profileName, removeProfile } from "@armoriq/sdk-dev/dist/credentials.js";
import { PRODUCT } from "./install.ts";

export function hasLogin(backend: string): boolean {
  try {
    return Boolean(loadProfile({ backend, product: PRODUCT })?.apiKey);
  } catch {
    return false;
  }
}

// The SDK's own device login, the same code `armoriq login --product armorantigravity` runs, so the
// profile lands in ~/.armoriq/credentials.json where armoriq-agd reads it.
export async function deviceLogin(backend: string, force: boolean): Promise<boolean> {
  process.env.ARMORIQ_BACKEND_URL = backend;
  const { runCliMain } = await import("@armoriq/sdk-dev/dist/cli/index.js");
  const code = await runCliMain(["login", "--product", PRODUCT, ...(force ? ["--force"] : [])]);
  return code === 0 && hasLogin(backend);
}

export function logout(backend: string): string | null {
  const name = profileName(backend, PRODUCT);
  return removeProfile(name) ? name : null;
}
