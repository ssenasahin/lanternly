// The rules an API monitor checks its JSON response against, like
// "data.items[0].price is greater than 0". Pure on purpose: a rule and a parsed body
// go in, a verdict comes out, so every operator is pinned down by a unit test and the
// API's "Test now" gives exactly the answer the worker will.

export type Operator =
  "EQUALS" | "NOT_EQUALS" | "CONTAINS" | "GREATER_THAN" | "LESS_THAN" | "EXISTS" | "NOT_EXISTS";

export interface Rule {
  path: string;
  operator: Operator;
  // What the user typed. Unused by EXISTS and NOT_EXISTS.
  expected: string | null;
}

export interface RuleResult extends Rule {
  passed: boolean;
  // The value found at the path, as JSON, cut short if it's long; null if the path
  // led nowhere.
  received: string | null;
}

// Operators that only ask whether the path leads somewhere.
export const PRESENCE: ReadonlySet<Operator> = new Set(["EXISTS", "NOT_EXISTS"]);
const NUMERIC: ReadonlySet<Operator> = new Set(["GREATER_THAN", "LESS_THAN"]);

const MAX_RECEIVED = 200;

export type PathSegment = string | number;

export class PathError extends Error {}

// "data.items[0].price" → ["data", "items", 0, "price"]. A leading "$" or "$." is
// allowed, as JSONPath users type it, and "$" on its own means the whole body. Keys
// with dots or spaces go in quotes: data["first name"].
export function parsePath(path: string): PathSegment[] {
  let rest = path.trim().replace(/^\$\.?/, "");
  const segments: PathSegment[] = [];
  while (rest) {
    // After a dot only a plain key may follow: "a..b" and "a.[0]" are slips.
    let afterDot = false;
    if (segments.length > 0) {
      if (rest.startsWith(".")) [rest, afterDot] = [rest.slice(1), true];
      else if (!rest.startsWith("[")) throw new PathError("Separate keys with a dot");
    }
    const match = /^(?:\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|([^.[\]"\s]+))/.exec(rest);
    if (afterDot && match?.[3] === undefined) throw new PathError("Put a key after each dot");
    if (!match) throw new PathError("Use keys and [0]-style indexes, like data.items[0].price");
    const [token, index, quoted, key] = match;
    if (index !== undefined) segments.push(Number(index));
    else if (quoted !== undefined) segments.push(quoted.replace(/\\(.)/g, "$1"));
    else segments.push(key!);
    rest = rest.slice(token.length);
  }
  return segments;
}

// Follows the path into the body. Only the body's own keys count, so a path like
// "constructor" finds nothing rather than something from JavaScript's prototype.
function lookUp(body: unknown, path: PathSegment[]): { found: boolean; value?: unknown } {
  let current = body;
  for (const segment of path) {
    if (Array.isArray(current)) {
      // items.0 works as well as items[0].
      const index = typeof segment === "number" ? segment : /^\d+$/.test(segment) ? +segment : -1;
      if (index < 0 || index >= current.length) return { found: false };
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      const key = String(segment);
      if (!Object.hasOwn(current, key)) return { found: false };
      current = (current as Record<string, unknown>)[key];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

// The expected value is typed as text, so "42" has to match the number 42, "true"
// the boolean and "null" null, while "ok" matches the string ok (quoted or not).
function same(actual: unknown, expected: string): boolean {
  if (typeof actual === "string") {
    if (actual === expected) return true;
  }
  try {
    return deepEqual(actual, JSON.parse(expected));
  } catch {
    return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every(
      (k) =>
        Object.hasOwn(b, k) &&
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

// Numbers, and strings that are plainly numbers: plenty of APIs send "12.50".
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function holds(operator: Operator, found: boolean, actual: unknown, expected: string): boolean {
  // Every comparison needs something to compare.
  if (!found) return operator === "NOT_EXISTS";
  switch (operator) {
    case "EXISTS":
      return true;
    case "NOT_EXISTS":
      return false;
    case "EQUALS":
      return same(actual, expected);
    case "NOT_EQUALS":
      return !same(actual, expected);
    case "CONTAINS":
      if (typeof actual === "string") return actual.includes(expected);
      if (Array.isArray(actual)) return actual.some((item) => same(item, expected));
      return false;
    case "GREATER_THAN":
    case "LESS_THAN": {
      const a = asNumber(actual);
      const b = asNumber(expected);
      if (a === null || b === null) return false;
      return operator === "GREATER_THAN" ? a > b : a < b;
    }
  }
}

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > MAX_RECEIVED ? `${text.slice(0, MAX_RECEIVED - 1)}…` : text;
}

export function evaluateRule(rule: Rule, body: unknown): RuleResult {
  let path: PathSegment[];
  try {
    path = parsePath(rule.path);
  } catch {
    // Saved rules are validated, so this only happens to a rule tested unsaved.
    return { ...rule, passed: false, received: null };
  }
  const { found, value } = lookUp(body, path);
  return {
    ...rule,
    passed: holds(rule.operator, found, value, rule.expected ?? ""),
    received: found ? show(value) : null,
  };
}

export function evaluateRules(rules: Rule[], body: unknown): RuleResult[] {
  return rules.map((rule) => evaluateRule(rule, body));
}

// Why a rule can't be saved, in words for the form, or null if it's fine.
export function ruleProblem(rule: Rule): string | null {
  try {
    parsePath(rule.path);
  } catch (err) {
    return (err as Error).message;
  }
  if (PRESENCE.has(rule.operator)) return null;
  if (rule.expected === null || rule.expected === "") return "Enter the value to compare with";
  if (NUMERIC.has(rule.operator) && asNumber(rule.expected) === null) {
    return "Compare with a number";
  }
  return null;
}

const VERBS: Record<Operator, string> = {
  EQUALS: "equal",
  NOT_EQUALS: "not equal",
  CONTAINS: "contain",
  GREATER_THAN: "be greater than",
  LESS_THAN: "be less than",
  EXISTS: "exist",
  NOT_EXISTS: "not exist",
};

// 'data.status should equal ok, got "degraded"': one line for an alert or a log.
export function describeFailure(result: RuleResult): string {
  const expected = PRESENCE.has(result.operator) ? "" : ` ${result.expected}`;
  const got = result.received === null ? "nothing there" : result.received;
  return `${result.path} should ${VERBS[result.operator]}${expected}, got ${got}`;
}
