/** 20 ms of 48 kHz stereo s16le, one Discord Opus frame. */
export const DISCORD_FRAME_BYTES = 960 * 2 * 2;

/**
 * Hold this much audio before the voice player starts reading.
 * Starting on an empty stream burns Discord's missed-frame budget (100 ms
 * by default) before the first samples arrive.
 */
export const PREROLL_BYTES = DISCORD_FRAME_BYTES * 10;

export class PcmFeed {
  /**
   * @param {number} [prerollBytes]
   */
  constructor(prerollBytes = PREROLL_BYTES) {
    this.prerollBytes = prerollBytes;
    /** @type {Buffer[]} */
    this.pending = [];
    this.pendingBytes = 0;
    this.started = false;
  }

  reset() {
    this.pending = [];
    this.pendingBytes = 0;
    this.started = false;
  }

  /**
   * @param {Buffer} chunk
   * @returns {Buffer[] | null} PCM to write now, or null while prerolling
   */
  push(chunk) {
    if (chunk.length === 0) return [];
    if (this.started) return [chunk];
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes < this.prerollBytes) return null;
    return this.flush();
  }

  /**
   * @returns {Buffer[]}
   */
  flush() {
    const ready = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.started = true;
    return ready;
  }
}
