import { createHash } from 'node:crypto';
import { canonicalize } from './jcs.js';
import type { Event, IsoTime, Sha256Hex } from './types.js';

export function sha256Hex(data: string | Uint8Array): Sha256Hex {
  return createHash('sha256').update(data).digest('hex');
}

/** 行哈希：sha256(prevHash + JCS({ seq, at, event }))。 */
export function lineHash(prevHash: Sha256Hex, seq: number, at: IsoTime, event: Event): Sha256Hex {
  return sha256Hex(prevHash + canonicalize({ seq, at, event }));
}
