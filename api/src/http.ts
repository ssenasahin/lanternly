import type { ErrorRequestHandler } from "express";
import { z } from "zod";

// An error that is safe to show the client: its status and message are deliberate.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function validate<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, "Invalid request", z.flattenError(result.error).fieldErrors);
  }
  return result.data;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  // Malformed JSON from the client is their mistake, not a server error.
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Request body is not valid JSON" });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: "Request body is too large" });
    return;
  }
  // Anything else is a bug. Log it in full, but never send internals to the client.
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
};
