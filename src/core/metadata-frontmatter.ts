import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export function extractFrontmatterBlock(content: string): string | null {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const closingMatch = normalized.match(/^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/);
  if (!closingMatch) return null;
  const block = closingMatch[0];
  return block.endsWith("\n") ? block : `${block}\n`;
}

const MAX_FRONTMATTER_BYTES = 64 * 1024;

export function readFrontmatterOnly(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    let content = "";
    const buffer = Buffer.alloc(4096);
    const decoder = new StringDecoder("utf8");
    let bytesRead = 0;
    let totalBytes = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      totalBytes += bytesRead;
      if (totalBytes > MAX_FRONTMATTER_BYTES) return null;
      content += decoder.write(buffer.subarray(0, bytesRead));
      const normalizedPrefix = content.replace(/\r\n?/g, "\n");
      if (normalizedPrefix.length >= 4 && !"---\n".startsWith(normalizedPrefix) && !normalizedPrefix.startsWith("---\n")) {
        return null;
      }
      const block = extractFrontmatterBlock(content);
      if (block) return block;
    }
    content += decoder.end();
    if (Buffer.byteLength(content, "utf8") > MAX_FRONTMATTER_BYTES) return null;
    return extractFrontmatterBlock(content);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
