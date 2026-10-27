import { describe, expect, it } from "vitest";
import { acceptsStatus, normaliseStatusCodes, statusCodesProblem } from "./status-codes.js";

describe("acceptsStatus", () => {
  it.each([
    ["200", 200, true],
    ["200", 201, false],
    ["200-299", 204, true],
    ["200-299", 302, false],
    ["2xx", 299, true],
    ["2XX", 300, false],
    ["200, 304", 304, true],
    ["200, 304", 301, false],
    ["2xx, 404", 404, true],
  ])("%s with %i is %s", (text, status, accepted) => {
    expect(acceptsStatus(text, status)).toBe(accepted);
  });
});

describe("statusCodesProblem", () => {
  it("accepts every form people write", () => {
    for (const text of ["200", "200-299", "200 - 299", "2xx", "200, 201,304", "1xx,5xx"]) {
      expect(statusCodesProblem(text)).toBeNull();
    }
  });

  it.each([
    ["", /at least one/],
    [" , ", /at least one/],
    ["ok", /isn't a status code/],
    ["20", /isn't a status code/],
    ["6xx", /isn't a status code/],
    ["099", /100 to 599/],
    ["600", /100 to 599/],
    ["299-200", /low to high/],
  ])("refuses %j", (text, problem) => {
    expect(statusCodesProblem(text)).toMatch(problem);
  });
});

describe("normaliseStatusCodes", () => {
  it("tidies spacing and case", () => {
    expect(normaliseStatusCodes(" 200 - 299 ,304,2XX ")).toBe("200-299, 304, 2xx");
  });
});
