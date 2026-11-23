/** Preview-only browser APIs, without adding lib.dom to the Worker's globals. */
interface PreviewXmlElement {
  getAttribute(name: string): string | null;
  getAttributeNS(namespace: string, name: string): string | null;
}
interface PreviewXmlDocument {
  getElementsByTagName(name: string): ArrayLike<PreviewXmlElement>;
  getElementsByTagNameNS(
    namespace: string,
    name: string,
  ): ArrayLike<PreviewXmlElement>;
}
declare const DOMParser: {
  new (): {
    parseFromString(text: string, mime: "application/xml"): PreviewXmlDocument;
  };
};
declare const IntersectionObserver: {
  new (
    callback: (entries: { isIntersecting: boolean }[]) => void,
    options: { rootMargin: string },
  ): {
    observe(element: HTMLElement): void;
    disconnect(): void;
  };
};
interface HTMLCanvasElement {
  width: number;
  height: number;
  toBlob(callback: (blob: Blob | null) => void, type: string): void;
  getContext(type: "2d"): {
    drawImage(
      bitmap: PreviewBitmap,
      x: number,
      y: number,
      width: number,
      height: number,
    ): void;
  } | null;
}
interface PreviewBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}
declare function createImageBitmap(
  blob: Blob,
  options: { resizeWidth: number; resizeHeight: number; resizeQuality: "low" },
): Promise<PreviewBitmap>;
interface Document {
  createElement(name: "canvas"): HTMLCanvasElement;
}
declare const document: Document;
declare const Worker: {
  new (
    url: string,
    options: { type: "module" },
  ): Worker & { terminate(): void };
};
