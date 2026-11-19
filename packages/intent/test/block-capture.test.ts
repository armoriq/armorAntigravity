import { expect, test } from "bun:test";
import contract from "./fixtures/block-capture-v1.json";
import current from "../../core/src/contracts/block-capture-v1.json";

// regression: #0010
test("the block capture fixture used by producer tests matches the current wire contract", () => {
  expect(contract).toEqual(current);
});
