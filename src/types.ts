/** Raw scraped product data from the website */
export interface RawProduct {
  id: string;
  productUrl: string;
  imageUrl: string;
  additionalImages: string[];
  title: string;
  description: string;
  category: string;
  gender: string | null;
  price: string;
  sale: string | null;
  sizes: string;
  tags: string[];
  metadata: Record<string, unknown>;
  onSale: boolean;
  prices: PriceEntry[];
  salePrices: PriceEntry[] | null;
  shopifyData: Record<string, unknown>;
  country: string | null;
}

export interface PriceEntry {
  currency: string;
  amount: number;
  formatted: string;
}

/** A product record as stored in the Supabase "products" table */
export interface DbProductRecord {
  id: string;
  source: string;
  product_url: string;
  image_url: string;
  title: string;
  description: string | null;
  category: string | null;
  gender: string | null;
  price: string | null;
  sale: string | null;
  size: string | null;
  tags: string[] | null;
  additional_images: string | null;
  metadata: string | null; // JSON string
  country: string | null;
  image_embedding: number[] | null;
  info_embedding: number[] | null;
  created_at: string | null;
  [key: string]: unknown;
}

export interface ProductDecision {
  product: RawProduct;
  action: "new" | "changed" | "unchanged";
  existingRecord: DbProductRecord | null;
  /** Only set when action=CHANGED — which specific fields changed */
  changedFields?: string[];
}

/** Batch upsert result */
export interface BatchResult {
  successCount: number;
  failedCount: number;
  failedProducts: Array<{ id: string; title: string; error: string }>;
}

/** Run summary printed at the end */
export interface RunSummary {
  totalSeen: number;
  newProducts: number;
  updatedProducts: number;
  unchangedProducts: number;
  staleDeleted: number;
  failedProducts: number;
}
