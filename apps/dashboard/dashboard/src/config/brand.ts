/**
 * Brand + product identity — single source for every placeholder the UI needs.
 * Rule 6: replace `[YOUR PRODUCT]` / `[YOUR DOMAIN]` here once, everywhere.
 */
export const BRAND = {
  /** Product display name (sidebar, tab title, auth headings). */
  product: 'LiveChat',
  /** Public origin of the marketing/site + widget CDN host, for install snippets. */
  domain: 'localhost:4321',
  /** Canonical CDN URL the widget <script src> points at. */
  widgetCdn: 'http://localhost:4321/widget.js',
  /** Favicon path served from /public. */
  favicon: '/favicon.svg',
} as const;

export type Brand = typeof BRAND;
