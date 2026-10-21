import { describe, it, expect } from "vitest";
import { failureLine } from "../src/logic.js";

const err = (status, code, message = "hub text") => Object.assign(new Error(message), { status, code });
const words = { action: "save the draft", thing: "draft" };

describe("failureLine", () => {
  it("says what a refusal was, never the hub's text", () => {
    expect(failureLine(err(403), words)).toBe("You don’t have permission to save the draft.");
    expect(failureLine(err(507), words)).toBe("The household’s storage is full — free up space first.");
    expect(failureLine(err(429), words)).toBe("Too many tries — wait a minute and try again.");
    expect(failureLine(err(400, "UNIQUE_CONSTRAINT"), words)).toBe("That draft already exists.");
    for (const e of [new TypeError("Failed to fetch"), err(400), err(500)]) {
      expect(failureLine(e, words)).toBe("Couldn’t save the draft — try again.");
    }
  });
  it("shows a message the app worded itself", () => {
    expect(failureLine(Object.assign(new Error("This form was already submitted."), { forUser: true }), words))
      .toBe("This form was already submitted.");
  });
});
