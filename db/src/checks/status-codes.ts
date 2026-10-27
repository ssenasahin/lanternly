// The status codes an API monitor accepts, written the way people say them:
// "200", "200-299", "2xx", or a list like "200, 201, 304".

type Span = [from: number, to: number];

export class StatusCodesError extends Error {}

export function parseStatusCodes(text: string): Span[] {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new StatusCodesError("Enter at least one status code");
  return parts.map((part) => {
    let span: Span;
    const family = /^([1-5])xx$/i.exec(part);
    const range = /^(\d{3})\s*-\s*(\d{3})$/.exec(part);
    if (family) span = [Number(family[1]) * 100, Number(family[1]) * 100 + 99];
    else if (range) span = [Number(range[1]), Number(range[2])];
    else if (/^\d{3}$/.test(part)) span = [Number(part), Number(part)];
    else throw new StatusCodesError(`"${part}" isn't a status code, a range like 200-299, or 2xx`);
    const [from, to] = span;
    if (from < 100 || to > 599) throw new StatusCodesError("Status codes run from 100 to 599");
    if (from > to) throw new StatusCodesError(`Write the range ${part} low to high`);
    return span;
  });
}

// Why the text can't be used, or null if it's fine.
export function statusCodesProblem(text: string): string | null {
  try {
    parseStatusCodes(text);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// "200, 201, 300-399" with the spaces tidied, as it's stored and shown.
export function normaliseStatusCodes(text: string): string {
  return text
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/\s*-\s*/, "-")
        .toLowerCase(),
    )
    .filter(Boolean)
    .join(", ");
}

export function acceptsStatus(text: string, status: number): boolean {
  return parseStatusCodes(text).some(([from, to]) => status >= from && status <= to);
}
