import { isIP } from "node:net";

// A TCP monitor's target: "db.example.com:5432", "203.0.114.10:22", or an IPv6
// address in brackets, "[2001:db8::1]:443", as URLs write it.

export class HostPortError extends Error {}

export function parseHostPort(target: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^\s:[\]/]+)):(\d{1,5})$/i.exec(target.trim());
  if (!match) {
    // A bare IPv6 address has colons of its own; say how to write one.
    if (isIP(target.trim()) === 6)
      throw new HostPortError("Put an IPv6 address in brackets: [2001:db8::1]:443");
    throw new HostPortError("Enter a host and a port, like db.example.com:5432");
  }
  const [, ipv6, name, digits] = match;
  if (ipv6 !== undefined && isIP(ipv6) !== 6) throw new HostPortError("That isn't an IPv6 address");
  const port = Number(digits);
  if (port < 1 || port > 65535) throw new HostPortError("Ports run from 1 to 65535");
  return { host: (ipv6 ?? name!).toLowerCase(), port };
}

// The form a target is stored and shown in.
export function formatHostPort(host: string, port: number): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}
