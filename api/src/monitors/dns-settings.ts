import { isPublicAddress, type Prisma } from "@lanternly/db";
import { z } from "zod";

// What a DNS monitor asks for. The name it asks about is the monitor's target.
export const dnsSettings = z.object({
  recordType: z.enum(["A", "AAAA", "CNAME", "MX", "TXT"]).default("A"),
  // Blank means any answer will do.
  expected: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((v) => v || null),
  // Only a public server: one on a private network would let a monitor probe ours.
  resolver: z
    .string()
    .trim()
    .nullish()
    .transform((v) => v || null)
    .refine((v) => v === null || isPublicAddress(v), {
      message: "Use a public DNS server's IP address, like 1.1.1.1",
    }),
});

export type DnsSettings = z.infer<typeof dnsSettings>;

export const dnsFields = {
  dnsQuery: { select: { recordType: true, expected: true, resolver: true } },
} satisfies Prisma.MonitorSelect;

type DnsRow = Prisma.MonitorGetPayload<{ select: typeof dnsFields }>["dnsQuery"];

// The settings as the browser sees them; null for monitors of other types.
export function presentDns(row: DnsRow): DnsSettings | null {
  return row ? { ...row } : null;
}
