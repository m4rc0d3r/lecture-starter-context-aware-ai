/**
 * Split text into overlapping chunks.
 */
export function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  const step = size - overlap;

  for (let i = 0; i < text.length; i += step) {
    chunks.push(text.slice(i, i + size));
  }

  return chunks;
}
