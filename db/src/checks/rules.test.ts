import { describe, expect, it } from "vitest";
import {
  describeFailure,
  evaluateRule,
  parsePath,
  ruleProblem,
  type Operator,
  type Rule,
} from "./rules.js";

const body = {
  status: "ok",
  version: 3,
  live: true,
  note: null,
  price: "12.50",
  data: {
    items: [
      { id: 7, price: 19.9, tags: ["new", "sale"] },
      { id: 8, price: 0, tags: [] },
    ],
    "first name": "Ada",
  },
};

const check = (path: string, operator: Operator, expected: string | null = null) =>
  evaluateRule({ path, operator, expected }, body).passed;

describe("parsePath", () => {
  it.each([
    ["status", ["status"]],
    ["data.items[0].price", ["data", "items", 0, "price"]],
    ["$.data.items[1]", ["data", "items", 1]],
    ['data["first name"]', ["data", "first name"]],
    ['data["a\\"b"]', ["data", 'a"b']],
    ["$", []],
    ["[0].id", [0, "id"]],
  ])("reads %s", (path, segments) => {
    expect(parsePath(path)).toEqual(segments);
  });

  it.each(["data..items", "data items", "data.[0]", "data[x]", 'data["open'])(
    "refuses %s",
    (path) => {
      expect(() => parsePath(path)).toThrow();
    },
  );
});

describe("EQUALS", () => {
  it("matches strings with or without quotes", () => {
    expect(check("status", "EQUALS", "ok")).toBe(true);
    expect(check("status", "EQUALS", '"ok"')).toBe(true);
    expect(check("status", "EQUALS", "OK")).toBe(false);
  });

  it("matches numbers, booleans and null by value", () => {
    expect(check("version", "EQUALS", "3")).toBe(true);
    expect(check("version", "EQUALS", "3.0")).toBe(true);
    expect(check("version", "EQUALS", "4")).toBe(false);
    expect(check("live", "EQUALS", "true")).toBe(true);
    expect(check("note", "EQUALS", "null")).toBe(true);
  });

  it("doesn't let the number 3 equal the string 3, or the reverse", () => {
    expect(evaluateRule({ path: "v", operator: "EQUALS", expected: '"3"' }, { v: 3 }).passed).toBe(
      false,
    );
    expect(
      evaluateRule({ path: "v", operator: "EQUALS", expected: "true" }, { v: "yes" }).passed,
    ).toBe(false);
  });

  it("compares arrays and objects by their contents", () => {
    expect(check("data.items[0].tags", "EQUALS", '["new","sale"]')).toBe(true);
    expect(check("data.items[1]", "EQUALS", '{"price":0,"id":8,"tags":[]}')).toBe(true);
    expect(check("data.items[1]", "EQUALS", '{"id":8}')).toBe(false);
  });

  it("fails when the path leads nowhere", () => {
    expect(check("data.items[5].price", "EQUALS", "0")).toBe(false);
  });
});

describe("NOT_EQUALS", () => {
  it("is the opposite of EQUALS", () => {
    expect(check("status", "NOT_EQUALS", "down")).toBe(true);
    expect(check("status", "NOT_EQUALS", "ok")).toBe(false);
  });

  it("still needs the value to be there", () => {
    expect(check("missing", "NOT_EQUALS", "down")).toBe(false);
  });
});

describe("CONTAINS", () => {
  it("finds text inside a string", () => {
    expect(check("status", "CONTAINS", "o")).toBe(true);
    expect(check("status", "CONTAINS", "x")).toBe(false);
  });

  it("finds an item in an array", () => {
    expect(check("data.items[0].tags", "CONTAINS", "sale")).toBe(true);
    expect(check("data.items[1].tags", "CONTAINS", "sale")).toBe(false);
    expect(check("data.items", "CONTAINS", '{"id":8,"price":0,"tags":[]}')).toBe(true);
  });

  it("doesn't apply to numbers or objects", () => {
    expect(check("version", "CONTAINS", "3")).toBe(false);
    expect(check("data", "CONTAINS", "items")).toBe(false);
  });
});

describe("GREATER_THAN and LESS_THAN", () => {
  it("compare numbers", () => {
    expect(check("data.items[0].price", "GREATER_THAN", "0")).toBe(true);
    expect(check("data.items[1].price", "GREATER_THAN", "0")).toBe(false);
    expect(check("data.items[1].price", "LESS_THAN", "0.5")).toBe(true);
    expect(check("version", "LESS_THAN", "3")).toBe(false);
  });

  it("read a number sent as a string", () => {
    expect(check("price", "GREATER_THAN", "12")).toBe(true);
    expect(check("price", "LESS_THAN", "12.5")).toBe(false);
  });

  it("fail for anything that isn't a number", () => {
    expect(check("status", "GREATER_THAN", "0")).toBe(false);
    expect(check("live", "LESS_THAN", "5")).toBe(false);
    expect(check("note", "LESS_THAN", "5")).toBe(false);
    expect(check("missing", "LESS_THAN", "5")).toBe(false);
  });
});

describe("EXISTS and NOT_EXISTS", () => {
  it("ask only whether the path leads somewhere", () => {
    expect(check("data.items[1].price", "EXISTS")).toBe(true);
    // null is a value: the key is there.
    expect(check("note", "EXISTS")).toBe(true);
    expect(check("error", "EXISTS")).toBe(false);
    expect(check("error", "NOT_EXISTS")).toBe(true);
    expect(check("status", "NOT_EXISTS")).toBe(false);
  });

  it("never find JavaScript's own properties", () => {
    expect(check("constructor", "EXISTS")).toBe(false);
    expect(check("data.items.length", "EXISTS")).toBe(false);
    expect(check("status.length", "EXISTS")).toBe(false);
  });

  it("index arrays with a dot as well as brackets", () => {
    expect(check("data.items.0.id", "EQUALS", "7")).toBe(true);
  });
});

describe("evaluateRule", () => {
  it("reports what it found, as JSON", () => {
    expect(evaluateRule({ path: "status", operator: "EQUALS", expected: "down" }, body)).toEqual({
      path: "status",
      operator: "EQUALS",
      expected: "down",
      passed: false,
      received: '"ok"',
    });
    expect(evaluateRule({ path: "nope", operator: "EXISTS", expected: null }, body).received).toBe(
      null,
    );
  });

  it("cuts a long value short", () => {
    const received = evaluateRule(
      { path: "$", operator: "EXISTS", expected: null },
      { log: "x".repeat(500) },
    ).received!;
    expect(received).toHaveLength(200);
    expect(received.endsWith("…")).toBe(true);
  });

  it("checks a body that's a plain value", () => {
    expect(evaluateRule({ path: "$", operator: "EQUALS", expected: "pong" }, "pong").passed).toBe(
      true,
    );
  });
});

describe("ruleProblem", () => {
  const rule = (r: Partial<Rule>): Rule => ({
    path: "status",
    operator: "EQUALS",
    expected: "ok",
    ...r,
  });

  it("accepts a well-formed rule", () => {
    expect(ruleProblem(rule({}))).toBeNull();
    expect(ruleProblem(rule({ operator: "EXISTS", expected: null }))).toBeNull();
  });

  it("explains what's wrong", () => {
    expect(ruleProblem(rule({ path: "a..b" }))).toMatch(/dot/);
    expect(ruleProblem(rule({ expected: "" }))).toMatch(/value/);
    expect(ruleProblem(rule({ operator: "GREATER_THAN", expected: "lots" }))).toMatch(/number/);
  });
});

describe("describeFailure", () => {
  it("says what was expected and what came back", () => {
    const failed = evaluateRule({ path: "status", operator: "EQUALS", expected: "down" }, body);
    expect(describeFailure(failed)).toBe('status should equal down, got "ok"');

    const missing = evaluateRule({ path: "error", operator: "EXISTS", expected: null }, body);
    expect(describeFailure(missing)).toBe("error should exist, got nothing there");
  });
});
