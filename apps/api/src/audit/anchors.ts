import { readFile } from 'node:fs/promises';
import type { AuditAnchor } from './auditLog.js';

export async function loadAuditAnchors(source: string): Promise<AuditAnchor[]> {
  let content: string;
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Could not fetch anchors (${response.status}).`);
    content = await response.text();
  } else {
    content = await readFile(source, 'utf8');
  }
  const anchors: AuditAnchor[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid anchor JSON on line ${index + 1}.`);
    }
    if (!value || typeof value !== 'object') throw new Error(`Invalid anchor on line ${index + 1}.`);
    const anchor = value as Record<string, unknown>;
    if (
      typeof anchor.timestamp !== 'string' || !Number.isFinite(Date.parse(anchor.timestamp)) ||
      typeof anchor.seq !== 'number' || !Number.isSafeInteger(anchor.seq) || anchor.seq < 1 ||
      typeof anchor.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(anchor.hash)
    ) throw new Error(`Invalid anchor fields on line ${index + 1}.`);
    anchors.push({ timestamp: anchor.timestamp, seq: anchor.seq, hash: anchor.hash.toLowerCase() });
  }
  return anchors;
}
