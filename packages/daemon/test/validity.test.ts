import { expect, test } from "bun:test";
import { startDaemon } from "../src/daemon.ts";

test.each(["bad", "179", "3601", "180.5", ""])("startup refuses intent validity %p before opening sockets", async value => {
  await expect(startDaemon({ env: { ARMORIQ_INTENT_VALIDITY_SECONDS: value }, plugins: [] })).rejects.toThrow("ARMORIQ_INTENT_VALIDITY_SECONDS");
});
