export interface RawProduct {
  /** Shopify product ID (used as our unique id) */
  id: string;
  /** Product page URL */
  productUrl: string;
  /** Primary image URL (first image) */
  imageUrl: string;
  /** Additional image URLs */
  additionalImages: string[];
  /** Product title/name */
  title: string;
  /** Product description (HTML or plain) */
  description: string;
  /** Product category / type (e.g., "T-Shirts", "Sweaters") */
  category: string;
  /** Gender: null, "unisex", "men", "women" */
  gender: string | null;
  /** Original price (before any sale) – includes all available currencies */
  price: string;
  /** Sale price – null if not on sale */
  sale: string | null;
  /** Available sizes (comma-separated) */
  sizes: string;
  /** Comma-separated tags */
  tags: string[];
  /** Raw metadata JSON blob for everything else */
  metadata: Record<string, unknown>;
  /** Whether the product is on sale */
  onSale: boolean;
  /** Available currencies with prices */
  prices: PriceEntry[];
  /** Sale prices per currency if on sale */
  salePrices: PriceEntry[] | null;
  /** The Shopify product JSON for reference */
  shopifyData: Record<string, unknown>;
  /** Country */
  country: string | null;
}

export interface PriceEntry {
  currency: string;
  amount: number;
  formatted: string;
}

export interface ScrapedCollection {
  url: string;
  productUrls: string[];
  pageNumber: number;
}

export interface ScraperProgress {
  totalProductsFound: number;
  currentPage: number;
  currentCollection: string;
  productsScraped: number;
  productsImported: number;
}
