const DISCONTINUITY = 0xffffffff;
const MAX_FRAME = 256 * 1024;

/**
 * Frames from the Spotify engine: a little-endian length, then that many PCM
 * bytes. A length of 0xffffffff is a discontinuity (seek or new track).
 */
export class PcmParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    /** @type {((pcm: Buffer) => void) | null} */
    this.onPcm = null;
    /** @type {(() => void) | null} */
    this.onDiscontinuity = null;
  }

  /**
   * @param {Buffer} chunk
   */
  push(chunk) {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : Buffer.from(chunk);

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === DISCONTINUITY) {
        this.buffer = this.buffer.subarray(4);
        this.onDiscontinuity?.();
        continue;
      }
      if (length > MAX_FRAME) {
        throw new Error(`PCM frame is too large (${length})`);
      }
      if (this.buffer.length < 4 + length) return;
      const pcm = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      this.onPcm?.(Buffer.from(pcm));
    }
  }
}
