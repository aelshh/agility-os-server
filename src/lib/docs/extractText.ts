/**
 * Extracts plain text from uploaded knowledge-dump documents so it can be
 * persisted alongside the file (course_documents.text_content) and used for
 * prompt grounding / FAQ generation.
 *
 * Returns null when the file type is unsupported or extraction fails — the
 * document row still exists; only its text is missing.
 */

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

const PLAIN_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "log",
  "xml",
  "html",
  "htm",
  "yaml",
  "yml",
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "";
  return filename.slice(dot + 1).toLowerCase();
}

function isPlainText(name: string, mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  return PLAIN_EXTENSIONS.has(extensionOf(name));
}

export async function extractText(
  filename: string,
  mimeType: string,
  buffer: Buffer,
): Promise<string | null> {
  try {
    if (isPlainText(filename, mimeType)) {
      return buffer.toString("utf8").slice(0, 200_000);
    }

    if (extensionOf(filename) === "pdf" || mimeType === "application/pdf") {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return result.text.slice(0, 200_000);
      } finally {
        await parser.destroy();
      }
    }

    if (
      extensionOf(filename) === "docx" ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.slice(0, 200_000);
    }

    return null;
  } catch (err) {
    console.error("[course-documents] text extraction failed", filename, err);
    return null;
  }
}