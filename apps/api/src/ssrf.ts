import { lookup } from 'node:dns/promises';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(ip, bits, 'ipv4');
}
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');

export async function assertPublicHttpsUrl(raw: string, allowedPorts: number[] = [443]): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error('Only https URLs are allowed');
  if (u.port && !allowedPorts.includes(Number(u.port))) throw new Error('Port not allowed');
  if (u.username || u.password) throw new Error('Credentials in URL are not allowed');
  const addrs = await lookup(u.hostname, { all: true });
  for (const a of addrs) {
    const family = a.family === 6 ? 'ipv6' : 'ipv4';
    if (blocked.check(a.address, family)) throw new Error('Address is not allowed');
  }
  return u;
}
