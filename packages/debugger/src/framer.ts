/**
 * @ai-factory/debugger — DAP stdio framing.
 *
 * DAP messages on stdio are framed exactly like LSP:
 *   Content-Length: <bytes>\r\n
 *   \r\n
 *   <utf8 JSON>
 * Headers other than Content-Length are ignored. The framer is incremental:
 * push() any chunk size and it returns every complete message decoded so far.
 * Malformed frames fail closed (the chunk is dropped and the framer resets).
 */

const HEADER_SEP = '\r\n\r\n';
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export function encodeMessage(msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, json]);
}

export class DapFramer {
  private buf = Buffer.alloc(0);

  /**
   * Feed raw bytes; returns the complete decoded messages (JSON values).
   * A corrupt frame (bad length, invalid JSON) is dropped and the framer
   * resets rather than desynchronizing the stream.
   */
  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      const sepIdx = this.buf.indexOf(HEADER_SEP);
      if (sepIdx < 0) break;
      const headerText = this.buf.slice(0, sepIdx).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!m) {
        // No usable length — drop through the separator and keep scanning.
        this.buf = this.buf.slice(sepIdx + HEADER_SEP.length);
        continue;
      }
      const len = Number(m[1]);
      if (!Number.isSafeInteger(len) || len > MAX_MESSAGE_BYTES) {
        this.buf = Buffer.alloc(0);
        break;
      }
      const bodyStart = sepIdx + HEADER_SEP.length;
      if (this.buf.length < bodyStart + len) break;
      const body = this.buf.slice(bodyStart, bodyStart + len);
      this.buf = this.buf.slice(bodyStart + len);
      try {
        out.push(JSON.parse(body.toString('utf8')));
      } catch {
        // Invalid JSON — drop the frame, keep the stream alive.
      }
    }
    return out;
  }
}
