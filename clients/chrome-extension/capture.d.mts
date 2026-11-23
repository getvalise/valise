export type ExtractedArticle = {
  detected: boolean;
  extractor: string;
  wordCount: number;
  pageWordCount: number;
  markdown: string;
  text: string;
  truncated: boolean;
  authors: string[];
  published: string | null;
  siteName: string | null;
  canonicalUrl: string | null;
  leadImage: string | null;
  description: string | null;
  language: string | null;
};
/** A file the archive's HTML refers to by name, such as page.css or img-001.png. */
export type ArchiveResource = {
  name: string;
  contentType: string;
  base64: string;
};
export type Snapshot = {
  title: string;
  url: string;
  html: string;
  capturedAt: string;
  resources: ArchiveResource[];
  /** Resources the page referred to that the capture could not keep. */
  skipped: number;
  article?: ExtractedArticle | null;
};
export type SelectionCapture = {
  title: string;
  url: string;
  quote: string;
  contextBefore: string;
  contextAfter: string;
};
export function capturePage(): Promise<Snapshot>;
export function captureSelection(): SelectionCapture | null;
