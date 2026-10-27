// The public API's contract, served at /docs. Written by hand to match the zod
// schemas in monitors/routes.ts; the tests check that every documented path answers.

const id = { type: "string", format: "uuid" };
const error = {
  description: "What went wrong, and per field when it's about the body",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          error: { type: "string", example: "Invalid request" },
          details: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
            example: { target: ["Enter a full URL, starting with https://"] },
          },
        },
      },
    },
  },
};

const monitorInput = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: 100, example: "Marketing site" },
    type: { type: "string", enum: ["HTTP", "API", "PING", "TCP", "DNS"] },
    target: {
      type: "string",
      description:
        "A URL for HTTP and API, a host for PING, host:port for TCP, a domain name for DNS. Private and reserved addresses are refused.",
      example: "https://example.com/health",
    },
    intervalSec: { type: "integer", minimum: 30, maximum: 300, default: 60 },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 30000, default: 10000 },
    retries: { type: "integer", minimum: 0, maximum: 5, default: 1 },
    slowAfterMs: {
      type: "integer",
      nullable: true,
      description: "Answers slower than this count as degraded. Must be below timeoutMs.",
    },
    escalationPolicyId: { ...id, nullable: true },
    api: {
      type: "object",
      description:
        "API monitors only: the request to send and the rules its JSON answer must pass.",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
        headers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: {
                type: "string",
                nullable: true,
                description: "null keeps a stored secret value",
              },
              secret: { type: "boolean" },
            },
          },
        },
        bodyType: { type: "string", enum: ["NONE", "JSON", "FORM"] },
        body: { type: "string", nullable: true },
        expectedStatus: { type: "string", example: "200-299" },
        rules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", example: "data.status" },
              operator: {
                type: "string",
                enum: [
                  "EQUALS",
                  "NOT_EQUALS",
                  "CONTAINS",
                  "GREATER_THAN",
                  "LESS_THAN",
                  "EXISTS",
                  "NOT_EXISTS",
                ],
              },
              expected: { type: "string", nullable: true },
            },
          },
        },
      },
    },
    dns: {
      type: "object",
      description: "DNS monitors only.",
      properties: {
        recordType: { type: "string", enum: ["A", "AAAA", "CNAME", "MX", "TXT"] },
        expected: { type: "string", nullable: true },
        resolver: { type: "string", nullable: true, example: "1.1.1.1" },
      },
    },
  },
};

const monitor = {
  type: "object",
  properties: {
    id,
    ...monitorInput.properties,
    type: { type: "string", enum: ["HTTP", "API", "PING", "TCP", "DNS", "HEARTBEAT", "AGENT"] },
    isActive: { type: "boolean" },
    status: { type: "string", enum: ["PENDING", "UP", "DOWN", "DEGRADED", "PAUSED"] },
    lastCheckedAt: { type: "string", format: "date-time", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const one = {
  description: "The monitor",
  content: { "application/json": { schema: { type: "object", properties: { monitor } } } },
};
const idParam = [{ name: "id", in: "path", required: true, schema: id }];
const body = (required: boolean) => ({
  required: true,
  content: {
    "application/json": {
      schema: required ? { ...monitorInput, required: ["name", "type", "target"] } : monitorInput,
    },
  },
});
const errors = { 400: error, 401: error, 404: error, 429: error };

export const openApi = {
  openapi: "3.0.3",
  info: {
    title: "Lanternly API",
    version: "1",
    description:
      "Manage monitors from code. Create a key under Account → API keys in the dashboard and send it as `Authorization: Bearer lnly_sk_…`. Each key may make 120 requests a minute.",
  },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: { apiKey: { type: "http", scheme: "bearer", bearerFormat: "lnly_sk_…" } },
  },
  security: [{ apiKey: [] }],
  paths: {
    "/monitors": {
      get: {
        summary: "List monitors",
        responses: {
          200: {
            description: "Every monitor, oldest first, with the last 24 hours hour by hour",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { monitors: { type: "array", items: monitor } },
                },
              },
            },
          },
          401: error,
        },
      },
      post: {
        summary: "Create a monitor",
        description: "It's checked right away, then on its interval.",
        requestBody: body(true),
        responses: { 201: one, 403: error, ...errors },
      },
    },
    "/monitors/{id}": {
      parameters: idParam,
      get: { summary: "Get a monitor", responses: { 200: one, ...errors } },
      patch: {
        summary: "Change a monitor",
        description: "Send only what changes. Changing the target or type starts its state fresh.",
        requestBody: body(false),
        responses: { 200: one, ...errors },
      },
      delete: {
        summary: "Delete a monitor and its history",
        responses: { 204: { description: "Deleted" }, ...errors },
      },
    },
    "/monitors/{id}/pause": {
      parameters: idParam,
      post: { summary: "Pause checks and alerts", responses: { 200: one, ...errors } },
    },
    "/monitors/{id}/resume": {
      parameters: idParam,
      post: { summary: "Resume checks and alerts", responses: { 200: one, ...errors } },
    },
    "/monitors/{id}/checks": {
      parameters: idParam,
      get: {
        summary: "Recent check results, newest first",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
        ],
        responses: { 200: { description: "The checks" }, ...errors },
      },
    },
    "/monitors/{id}/stats": {
      parameters: idParam,
      get: {
        summary: "Uptime and response times",
        parameters: [
          {
            name: "range",
            in: "query",
            schema: { type: "string", enum: ["1h", "24h", "7d", "30d"] },
          },
        ],
        responses: {
          200: { description: "Uptime over 24h, 7d and 30d, plus the range's figures" },
          ...errors,
        },
      },
    },
  },
};
