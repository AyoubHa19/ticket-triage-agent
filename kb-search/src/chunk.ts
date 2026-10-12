export interface SourceDoc {
  id: string;
  markdown: string;
}

export interface Chunk {
  id: string;
  docId: string;
  docTitle: string;
  /** Section heading. For `###` sections it is "Parent > Child". The document title is stored separately. */
  heading: string;
  text: string;
  /** What gets indexed: title and heading make a section findable by its name even if the body never repeats it. */
  indexText: string;
}

export interface ChunkOptions {
  /** Sections longer than this are split on paragraph boundaries. */
  maxChars?: number;
}

function splitLongSection(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const parts: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const paragraph of paragraphs) {
    if (current.length > 0 && length + paragraph.length > maxChars) {
      parts.push(current.join("\n\n"));
      // One paragraph of overlap keeps a sentence that straddles the boundary retrievable from both sides.
      const last = current[current.length - 1]!;
      current = last.length <= maxChars / 2 ? [last] : [];
      length = current.reduce((n, p) => n + p.length, 0);
    }
    current.push(paragraph);
    length += paragraph.length;
  }
  if (current.length > 0) parts.push(current.join("\n\n"));
  return parts;
}

/**
 * Heading-aware markdown chunking: one chunk per `##`/`###` section (split further if long).
 * Text before the first sub-heading is kept under the heading "Overview".
 */
export function chunkMarkdown(doc: SourceDoc, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? 700;
  const lines = doc.markdown.split(/\r?\n/);

  let title = doc.id;
  const sections: { heading: string; body: string[] }[] = [{ heading: "Overview", body: [] }];
  let parentHeading = "";

  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h1 && !h2 && !h3) {
      title = h1[1]!;
    } else if (h2) {
      parentHeading = h2[1]!;
      sections.push({ heading: parentHeading, body: [] });
    } else if (h3) {
      sections.push({ heading: parentHeading ? `${parentHeading} > ${h3[1]}` : h3[1]!, body: [] });
    } else {
      sections[sections.length - 1]!.body.push(line);
    }
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const body = section.body.join("\n").trim();
    if (body === "") continue;
    for (const part of splitLongSection(body, maxChars)) {
      chunks.push({
        id: `${doc.id}#${chunks.length}`,
        docId: doc.id,
        docTitle: title,
        heading: section.heading,
        text: part,
        indexText: `${title}\n${section.heading}\n${part}`,
      });
    }
  }
  return chunks;
}
