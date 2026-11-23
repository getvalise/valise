export const PAGE_SIZE = 30;

export type ListWindow = { limit: number; offset: number };

export function pageNumber(value: string | null): number | undefined {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 1 ? page : undefined;
}

export function pagination(total: number, requested = 1) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requested, pages);
  return {
    total,
    page,
    pages,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
}

/** The URL records how much of the list is revealed, so reloads keep its rows. */
export function infiniteWindow(total: number, requested = 1) {
  const window = pagination(total, requested);
  return { ...window, offset: 0, limit: window.page * PAGE_SIZE };
}
