import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The compact record format and canonical assistant-message encoding. */
export const ASSISTANT_SIGNATURE_INDEX_VERSION = 1;
export const ASSISTANT_SIGNATURE_CANONICAL_VERSION = 1;
export const ASSISTANT_SIGNATURE_INDEX_READ_CHUNK_BYTES = 64 * 1024;
export const ASSISTANT_SIGNATURE_INDEX_MAX_RECORD_BYTES = 64 * 1024;

interface SignatureRecord {
  v: number;
  c: number;
  s: number;
  d: string;
  b: number;
  m: number;
}

export interface AssistantSignatureIndexOptions {
  /** Test seam. Production uses SHA-256 of UTF-8 canonical message bytes. */
  digest?: (canonicalMessage: string) => string;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateOwnerIsValid(stat: fs.Stats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined || stat.uid === uid;
}

function assertPrivateDirectory(stat: fs.Stats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwnerIsValid(stat) || (stat.mode & 0o777) !== 0o700) {
    throw new Error("Assistant signature index parent is not private.");
  }
}

function assertPrivateFile(stat: fs.Stats): void {
  if (!stat.isFile() || !privateOwnerIsValid(stat) || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Assistant signature index is not private.");
  }
}

async function openVerified(filePath: string, flags: number): Promise<{ handle: fs.promises.FileHandle; stat: fs.Stats }> {
  const handle = await fs.promises.open(filePath, flags | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const pathnameStat = await fs.promises.lstat(filePath);
    assertPrivateFile(stat);
    if (pathnameStat.isSymbolicLink() || !sameIdentity(stat, pathnameStat)) {
      throw new Error("Assistant signature index path changed while opening.");
    }
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertPathMatches(filePath: string, descriptorStat: fs.Stats): Promise<void> {
  const pathnameStat = await fs.promises.lstat(filePath);
  if (pathnameStat.isSymbolicLink() || !sameIdentity(descriptorStat, pathnameStat)) {
    throw new Error("Assistant signature index path changed while reading.");
  }
}

function parseRecord(line: Buffer, expectedSequence: number): SignatureRecord {
  if (line.length === 0 || line.length > ASSISTANT_SIGNATURE_INDEX_MAX_RECORD_BYTES) {
    throw new Error("Assistant signature index record is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
  } catch {
    throw new Error("Assistant signature index record is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Assistant signature index record is invalid.");
  const record = value as Record<string, unknown>;
  if (
    record.v !== ASSISTANT_SIGNATURE_INDEX_VERSION ||
    record.c !== ASSISTANT_SIGNATURE_CANONICAL_VERSION ||
    record.s !== expectedSequence ||
    typeof record.d !== "string" || !/^[a-f0-9]{64}$/.test(record.d) ||
    !Number.isSafeInteger(record.b) || (record.b as number) < 0 ||
    !Number.isSafeInteger(record.m) || (record.m as number) < 0
  ) throw new Error("Assistant signature index record is invalid.");
  return record as unknown as SignatureRecord;
}

function defaultDigest(canonicalMessage: string): string {
  return crypto.createHash("sha256").update(canonicalMessage, "utf8").digest("hex");
}

function signature(canonicalMessage: string, digestMessage: (canonicalMessage: string) => string): Pick<SignatureRecord, "d" | "b"> {
  return { d: digestMessage(canonicalMessage), b: Buffer.byteLength(canonicalMessage, "utf8") };
}

/**
 * Append-only private metadata for inline assistant messages. It never writes
 * message content: only its SHA-256, canonical byte length, sequence, and the
 * matching public result.messages locator are persisted.
 */
export class AssistantSignatureIndex {
  readonly filePath: string;
  private nextSequence = 0;
  private disabled = false;
  private readonly digestMessage: (canonicalMessage: string) => string;

  constructor(directory: string, options: AssistantSignatureIndexOptions = {}) {
    this.filePath = path.join(directory, "assistant-signatures.idx");
    this.digestMessage = options.digest ?? defaultDigest;
  }

  get isEnabled(): boolean {
    return !this.disabled;
  }

  /** Publish one record durably, then descriptor/path read it back before use. */
  async append(canonicalMessage: string, publicMessageIndex: number): Promise<void> {
    if (this.disabled) return;
    try {
      if (!Number.isSafeInteger(publicMessageIndex) || publicMessageIndex < 0) throw new Error("Invalid public message locator.");
      const record: SignatureRecord = {
        v: ASSISTANT_SIGNATURE_INDEX_VERSION,
        c: ASSISTANT_SIGNATURE_CANONICAL_VERSION,
        s: this.nextSequence,
        ...signature(canonicalMessage, this.digestMessage),
        m: publicMessageIndex,
      };
      const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      if (encoded.length > ASSISTANT_SIGNATURE_INDEX_MAX_RECORD_BYTES) throw new Error("Assistant signature index record exceeds bound.");
      await this.appendAndVerify(encoded);
      this.nextSequence += 1;
    } catch {
      // Any uncertain index state is unusable. Callers fall back to exact
      // comparisons against public result.messages, so no message is omitted.
      this.disabled = true;
    }
  }

  /**
   * Returns a hash/length-only suffix-prefix candidate. The caller must perform
   * an exact canonical comparison against public messages before trusting it.
   */
  async findCandidateOverlap(canonicalMessages: readonly string[]): Promise<number | null> {
    if (this.disabled) return null;
    if (canonicalMessages.length === 0) return 0;
    try {
      const expected = canonicalMessages.map((message) => signature(message, this.digestMessage));
      const prefix = new Array<number>(expected.length).fill(0);
      for (let index = 1; index < expected.length; index += 1) {
        let matched = prefix[index - 1]!;
        while (matched > 0 && !this.sameSignature(expected[index]!, expected[matched]!)) matched = prefix[matched - 1]!;
        if (this.sameSignature(expected[index]!, expected[matched]!)) matched += 1;
        prefix[index] = matched;
      }

      const opened = await openVerified(this.filePath, fs.constants.O_RDONLY);
      try {
        let sequence = 0;
        let matched = 0;
        let terminalOverlap = 0;
        const chunk = Buffer.alloc(ASSISTANT_SIGNATURE_INDEX_READ_CHUNK_BYTES);
        let offset = 0;
        let remainder = Buffer.alloc(0);
        while (offset < opened.stat.size) {
          const { bytesRead } = await opened.handle.read(chunk, 0, Math.min(chunk.length, opened.stat.size - offset), offset);
          if (bytesRead === 0) throw new Error("Assistant signature index changed while reading.");
          offset += bytesRead;
          const combined = remainder.length ? Buffer.concat([remainder, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
          let start = 0;
          for (let index = 0; index < combined.length; index += 1) {
            if (combined[index] !== 0x0a) continue;
            const record = parseRecord(combined.subarray(start, index), sequence++);
            while (matched > 0 && !this.sameSignature(record, expected[matched]!)) matched = prefix[matched - 1]!;
            if (this.sameSignature(record, expected[matched]!)) matched += 1;
            if (matched === expected.length) {
              terminalOverlap = matched;
              matched = prefix[matched - 1]!;
            } else {
              terminalOverlap = matched;
            }
            start = index + 1;
          }
          remainder = Buffer.from(combined.subarray(start));
          if (remainder.length > ASSISTANT_SIGNATURE_INDEX_MAX_RECORD_BYTES) throw new Error("Assistant signature index record exceeds bound.");
        }
        if (remainder.length !== 0) throw new Error("Assistant signature index is incomplete.");
        await assertPathMatches(this.filePath, opened.stat);
        // KMP falls back to a proper prefix after a complete match; preserve
        // the full value when that match was the final indexed record.
        return terminalOverlap;
      } finally {
        await opened.handle.close();
      }
    } catch {
      this.disabled = true;
      return null;
    }
  }

  private sameSignature(left: Pick<SignatureRecord, "d" | "b">, right: Pick<SignatureRecord, "d" | "b">): boolean {
    return left.d === right.d && left.b === right.b;
  }

  private async appendAndVerify(encoded: Buffer): Promise<void> {
    assertPrivateDirectory(await fs.promises.lstat(path.dirname(this.filePath)));
    let opened: { handle: fs.promises.FileHandle; stat: fs.Stats };
    try {
      const handle = await fs.promises.open(this.filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      const stat = await handle.stat();
      assertPrivateFile(stat);
      opened = { handle, stat };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      opened = await openVerified(this.filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND);
    }
    const { handle, stat } = opened;
    const start = stat.size;
    try {
      let written = 0;
      while (written < encoded.length) {
        const { bytesWritten } = await handle.write(encoded, written, encoded.length - written, start + written);
        if (bytesWritten === 0) throw new Error("Could not publish assistant signature index.");
        written += bytesWritten;
      }
      await handle.sync();
      await assertPathMatches(this.filePath, stat);
    } finally {
      await handle.close();
    }

    const readBack = await openVerified(this.filePath, fs.constants.O_RDONLY);
    try {
      const buffer = Buffer.alloc(encoded.length);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await readBack.handle.read(buffer, read, buffer.length - read, start + read);
        if (bytesRead === 0) throw new Error("Could not read back assistant signature index.");
        read += bytesRead;
      }
      if (!buffer.equals(encoded)) throw new Error("Assistant signature index read-back mismatch.");
      await assertPathMatches(this.filePath, readBack.stat);
    } finally {
      await readBack.handle.close();
    }
  }
}
