import type { HttpMethod, Operator } from "../../api/monitors";

// The words for an API monitor's settings, kept apart from the form's schema so the
// detail page can use them without loading the validation library.

export const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

export const OPERATORS: { value: Operator; label: string }[] = [
  { value: "EQUALS", label: "equals" },
  { value: "NOT_EQUALS", label: "doesn't equal" },
  { value: "CONTAINS", label: "contains" },
  { value: "GREATER_THAN", label: "is greater than" },
  { value: "LESS_THAN", label: "is less than" },
  { value: "EXISTS", label: "exists" },
  { value: "NOT_EXISTS", label: "doesn't exist" },
];

export const OPERATOR_WORDS = Object.fromEntries(
  OPERATORS.map((o) => [o.value, o.label]),
) as Record<Operator, string>;

// Operators that only ask whether the path leads somewhere: no value to compare.
export const PRESENCE = new Set<Operator>(["EXISTS", "NOT_EXISTS"]);
