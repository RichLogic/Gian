function parseIpv4(hostname: string): [number, number, number, number] | null {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1).map(Number) as [number, number, number, number];
  if (octets.some((octet) => octet > 255)) return null;
  return octets;
}

function isNonPublicIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && octets[2] === 100) return true;
  if (a === 203 && b === 0 && octets[2] === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6(hostname: string): number[] | null {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.includes('.')) {
    const lastColon = host.lastIndexOf(':');
    const ipv4 = parseIpv4(host.slice(lastColon + 1));
    if (!ipv4 || lastColon < 0) return null;
    const head = expandIpv6(host.slice(0, lastColon));
    if (!head || head.length !== 6) return null;
    return [...head, (ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]];
  }
  return expandIpv6(host);
}

function expandIpv6(hostname: string): number[] | null {
  if (!hostname.includes(':')) return null;
  const [head, tail] = hostname.split('::');
  const parseGroup = (part: string | undefined): number[] | null => {
    if (!part) return [];
    const groups = part.split(':');
    if (groups.some((group) => group.length === 0 || group.length > 4 || !/^[0-9a-f]+$/.test(group))) {
      return null;
    }
    return groups.map((group) => Number.parseInt(group, 16));
  };
  if (tail === undefined) {
    const groups = parseGroup(head);
    return groups?.length === 8 ? groups : null;
  }
  if (hostname.indexOf('::') !== hostname.lastIndexOf('::')) return null;
  const left = parseGroup(head);
  const right = parseGroup(tail);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv4FromGroups(high: number, low: number): [number, number, number, number] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isNonPublicIpv6(groups: readonly number[]): boolean {
  if (groups.length !== 8) return true;
  if (groups.every((group) => group === 0)) return true;
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  const third = groups[2] ?? 0;
  const fourth = groups[3] ?? 0;
  const fifth = groups[4] ?? 0;
  const sixth = groups[5] ?? 0;
  const seventh = groups[6] ?? 0;
  const eighth = groups[7] ?? 0;
  if (first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0) {
    if (sixth === 0 && seventh === 0 && eighth === 1) return true;
    if (sixth === 0xffff || sixth === 0) {
      return isNonPublicIpv4(ipv4FromGroups(seventh, eighth));
    }
  }
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xffc0) === 0xfec0) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && second === 0xdb8) return true;
  if (first === 0x2001 && second === 2) return true;
  if (first === 0x2001 && second === 0) return true;
  if (first === 0x2001 && (second & 0xfff0) === 0x10) return true;
  if (first === 0x2001 && (second & 0xfff0) === 0x20) return true;
  if (first === 0x2002) {
    return isNonPublicIpv4(ipv4FromGroups(second, third));
  }
  if (first === 0x64 && second === 0xff9b && third === 0 && fourth === 0 && fifth === 0 && sixth === 0) {
    return isNonPublicIpv4(ipv4FromGroups(seventh, eighth));
  }
  if (first === 0x64 && second === 0xff9b && third === 1) return true;
  if (first === 0x100 && second === 0 && third === 0 && fourth === 0) return true;
  return false;
}

function isNonPublicLiteralHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipv4 = parseIpv4(host);
  if (ipv4) return isNonPublicIpv4(ipv4);
  if (host.startsWith('::ffff:')) {
    const mapped = parseIpv4(host.slice(7));
    return mapped ? isNonPublicIpv4(mapped) : true;
  }
  const ipv6 = parseIpv6(host);
  if (ipv6) return isNonPublicIpv6(ipv6);
  return false;
}

/** Host-side setup URL gate. Navigation only: exact HTTPS, no credentials/port. */
export function isPublicHttpsSetupUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:'
    && url.username === ''
    && url.password === ''
    && url.hostname.length > 0
    && url.port === ''
    && !isNonPublicLiteralHost(url.hostname);
}
