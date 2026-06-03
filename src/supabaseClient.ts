/**
 * Database manager for Vienze scraper.
 * Handles batch upserts, smart change detection, stale product removal, and error logging.
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  RawProduct,
  DbProductRecord,
  ProductDecision,
  BatchResult,
  RunSummary,
} from "./types.js";

const SOURCE = "scraper-vienze";
const BATCH_SIZE = 50;
const MAX_RETRIES = 3;
const LOG_FILE = path.resolve("failed-imports.log");

// ====================== Supabase Client ======================

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || "";

let supabase: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (!supabase) {
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars");
    }
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}

// ====================== Helpers ======================

/** Format a scraped price string for the DB, deduplicating by currency. e.g. "89EUR,60EUR" -> "89EUR" */
function formatPrice(p: string): string {
  if (!p) return "";
  const seen = new Set<string>();
  return p
    .split(",")
    .filter(Boolean)
    .filter((entry) => {
      const currency = entry.replace(/^[\d.]+/, "");
      if (seen.has(currency)) return false;
      seen.add(currency);
      return true;
    })
    .join(",");
}

/** Build the DB record shape from a scraped product (with or without embeddings) */
function buildRecord(
  product: RawProduct,
  imageEmbedding: number[] | null | undefined,
  infoEmbedding: number[] | null | undefined,
  staleMissedCount: number
): Record<string, unknown> {
  const meta = { ...product.metadata, stale_missed_count: staleMissedCount };

  return {
    id: product.id,
    source: SOURCE,
    product_url: product.productUrl,
    affiliate_url: null,
    image_url: product.imageUrl,
    brand: "Vienze",
    title: product.title,
    description: product.description || null,
    category: product.category || null,
    gender: product.gender,
    size: product.sizes || null,
    second_hand: false,
    country: null,
    compressed_image_url: null,
    tags: product.tags.length > 0 ? product.tags : null,
    price: formatPrice(product.price),
    sale: product.sale || null,
    additional_images:
      product.additionalImages.length > 0
        ? product.additionalImages.join(" , ")
        : null,
    metadata: JSON.stringify(meta),
    image_embedding: imageEmbedding ?? null,
    info_embedding: infoEmbedding ?? null,
  };
}

/** Create a fingerprint of meaningful product data for comparison */
function fingerprint(product: RawProduct): string {
  return JSON.stringify({
    title: product.title,
    description: product.description,
    category: product.category,
    gender: product.gender,
    price: product.price,
    sale: product.sale,
    sizes: product.sizes,
    tags: product.tags,
    imageUrl: product.imageUrl,
    additionalImages: product.additionalImages,
    country: product.country,
    onSale: product.onSale,
  });
}

/** Log failed products to a local file */
function logFailedProducts(products: Array<{ id: string; title: string; error: string }>): void {
  const lines = products.map(
    (p) =>
      `[${new Date().toISOString()}] FAILED id=${p.id} title="${p.title}" error="${p.error}"`
  );
  fs.appendFileSync(LOG_FILE, lines.join("\n") + "\n", "utf-8");
  console.error(`[DB] ${products.length} failures logged to ${LOG_FILE}`);
}

// ====================== DatabaseManager ======================

export class DatabaseManager {
  private existingProducts: Map<string, DbProductRecord> = new Map();
  private staleCounts: Map<string, number> = new Map();
  private summary: RunSummary = {
    totalSeen: 0, newProducts: 0, updatedProducts: 0,
    unchangedProducts: 0, staleDeleted: 0, failedProducts: 0,
  };

  // ---------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------

  async testConnection(): Promise<boolean> {
    try {
      const client = getClient();
      const { error } = await client.from("products").select("id").limit(1);
      if (error) {
        console.error("[DB] Connection test failed:", error);
        return false;
      }
      console.log('[DB] Connected to Supabase — table "products" OK ✓');
      return true;
    } catch (err) {
      console.error("[DB] Connection test failed:", err);
      return false;
    }
  }

  async fetchExisting(): Promise<void> {
    console.log("[DB] Fetching existing products from database...");
    const client = getClient();
    const all: DbProductRecord[] = [];
    let from = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await client
        .from("products")
        .select("*")
        .eq("source", SOURCE)
        .range(from, from + pageSize - 1);

      if (error) {
        console.error("[DB] Error fetching existing products:", error);
        throw error;
      }
      if (!data || data.length === 0) break;
      all.push(...(data as DbProductRecord[]));
      from += pageSize;
      if (data.length < pageSize) break;
    }

    for (const rec of all) {
      this.existingProducts.set(rec.product_url, rec);
      try {
        const meta = JSON.parse(rec.metadata || "{}");
        this.staleCounts.set(rec.product_url, (meta.stale_missed_count as number) || 0);
      } catch {
        this.staleCounts.set(rec.product_url, 0);
      }
    }
    console.log(`[DB] Found ${all.length} existing products ✓`);
  }

  // ---------------------------------------------------------------
  // Product comparison
  // ---------------------------------------------------------------

  compare(product: RawProduct): ProductDecision {
    const existing = this.existingProducts.get(product.productUrl) || null;
    if (!existing) {
      return { product, action: "new", existingRecord: null };
    }

    const scrapedFingerprint = fingerprint(product);
    const existingFingerprint = this.buildExistingFingerprint(existing, product);

    if (scrapedFingerprint !== existingFingerprint) {
      const changed = this.detectChanges(product, existing);
      return { product, action: "changed", existingRecord: existing, changedFields: changed };
    }

    return { product, action: "unchanged", existingRecord: existing };
  }

  private buildExistingFingerprint(rec: DbProductRecord, _scraped: RawProduct): string {
    const additionalImages = rec.additional_images?.split(" , ").filter(Boolean) || [];
    return JSON.stringify({
      title: rec.title,
      description: rec.description || "",
      category: rec.category || "",
      gender: rec.gender || null,
      price: rec.price || "",
      sale: rec.sale || null,
      sizes: rec.size || "",
      tags: rec.tags || [],
      imageUrl: rec.image_url || "",
      additionalImages,
      country: rec.country || null,
      onSale: false,
    });
  }

  private detectChanges(product: RawProduct, existing: DbProductRecord): string[] {
    const changed: string[] = [];
    if (product.title !== existing.title) changed.push("title");
    if (product.description !== (existing.description || "")) changed.push("description");
    if (product.category !== (existing.category || "")) changed.push("category");
    if (product.price !== (existing.price || "")) changed.push("price");
    if ((product.sale || null) !== (existing.sale || null)) changed.push("sale");
    if (product.sizes !== (existing.size || "")) changed.push("sizes");
    if (product.imageUrl !== (existing.image_url || "")) changed.push("imageUrl");
    return changed;
  }

  // ---------------------------------------------------------------
  // Batch upsert
  // ---------------------------------------------------------------

  private async upsertBatch(
    records: Array<{
      product: RawProduct;
      imageEmbedding: number[] | null;
      infoEmbedding: number[] | null;
    }>
  ): Promise<BatchResult> {
    const client = getClient();
    const payload = records.map((r) =>
      buildRecord(r.product, r.imageEmbedding, r.infoEmbedding, 0)
    );

    let lastError: string | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { error } = await (client.from("products") as any).upsert(payload, {
          onConflict: "source,product_url",
          ignoreDuplicates: false,
        });

        if (!error) {
          return { successCount: records.length, failedCount: 0, failedProducts: [] };
        }

        lastError = error.message;
        console.warn(`[DB] Batch upsert attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`);
      } catch (err) {
        lastError = String(err);
        console.warn(`[DB] Batch upsert attempt ${attempt}/${MAX_RETRIES} threw: ${err}`);
      }

      if (attempt < MAX_RETRIES) await delay(1000 * attempt);
    }

    const failed = records.map((r) => ({
      id: r.product.id,
      title: r.product.title,
      error: lastError || "Unknown error",
    }));
    logFailedProducts(failed);
    return { successCount: 0, failedCount: records.length, failedProducts: failed };
  }

  // ---------------------------------------------------------------
  // Main processing pipeline
  // ---------------------------------------------------------------

  processProducts(scrapedProducts: RawProduct[]): {
    decisions: ProductDecision[];
    needImageEmbedding: RawProduct[];
    needTextEmbedding: RawProduct[];
  } {
    const decisions: ProductDecision[] = [];
    const needImageEmbedding: RawProduct[] = [];
    const needTextEmbedding: RawProduct[] = [];

    for (const product of scrapedProducts) {
      const decision = this.compare(product);
      decisions.push(decision);

      switch (decision.action) {
        case "new":
          needImageEmbedding.push(product);
          needTextEmbedding.push(product);
          break;
        case "changed":
          if (decision.changedFields?.includes("imageUrl")) {
            needImageEmbedding.push(product);
            needTextEmbedding.push(product);
          } else {
            needTextEmbedding.push(product);
          }
          break;
        case "unchanged":
          break;
      }
    }

    return { decisions, needImageEmbedding, needTextEmbedding };
  }

  async upsertAll(
    decisions: ProductDecision[],
    embeddings: Map<string, { image: number[] | null; text: number[] | null }>
  ): Promise<void> {
    const batch: Array<{
      product: RawProduct;
      imageEmbedding: number[] | null;
      infoEmbedding: number[] | null;
    }> = [];

    let totalFailed = 0;

    for (const decision of decisions) {
      if (decision.action === "unchanged") {
        // Mark as seen without wiping embeddings — use targeted update
        await this.markAsSeen(decision.product);
        this.summary.unchangedProducts++;
        continue;
      }

      const emb = embeddings.get(decision.product.productUrl);
      batch.push({
        product: decision.product,
        imageEmbedding: emb?.image || null,
        infoEmbedding: emb?.text || null,
      });

      if (batch.length >= BATCH_SIZE) {
        const result = await this.upsertBatch(batch);
        totalFailed += result.failedCount;
        batch.length = 0;
      }
    }

    if (batch.length > 0) {
      const result = await this.upsertBatch(batch);
      totalFailed += result.failedCount;
    }

    this.summary.newProducts = decisions.filter((d) => d.action === "new").length;
    this.summary.updatedProducts = decisions.filter((d) => d.action === "changed").length;
    this.summary.failedProducts = totalFailed;
    this.summary.totalSeen = decisions.length;
  }

  /**
   * Mark a product as seen without wiping embeddings.
   * Uses targeted .update() on metadata only — never nulls out other columns.
   */
  private async markAsSeen(product: RawProduct): Promise<void> {
    const client = getClient();
    try {
      const existing = this.existingProducts.get(product.productUrl);
      let meta: Record<string, unknown> = {};
      if (existing?.metadata) {
        try { meta = JSON.parse(existing.metadata); } catch { /* */ }
      }
      meta.stale_missed_count = 0;

      await (client.from("products") as any)
        .update({ metadata: JSON.stringify(meta) })
        .eq("source", SOURCE)
        .eq("product_url", product.productUrl);
    } catch {
      // Non-critical — silent fail
    }
  }

  // ---------------------------------------------------------------
  // Stale product removal
  // ---------------------------------------------------------------

  async handleStaleProducts(seenProductUrls: Set<string>): Promise<void> {
    console.log("[DB] Checking for stale products...");
    const client = getClient();
    let deletedCount = 0;
    let firstMissCount = 0;

    for (const [url, record] of this.existingProducts.entries()) {
      if (seenProductUrls.has(url)) continue;

      const currentMissed = this.staleCounts.get(url) || 0;

      if (currentMissed >= 1) {
        // Missed on a previous run already — now missed again → delete
        const { error } = await client
          .from("products")
          .delete()
          .eq("source", SOURCE)
          .eq("product_url", url);

        if (error) {
          console.error(`[DB] Failed to delete stale product ${url}:`, error);
        } else {
          deletedCount++;
          console.log(`[DB] 🗑 Deleted stale product: "${record.title}" (${url})`);
        }
      } else {
        // First miss → increment stale count via targeted update
        try {
          let meta: Record<string, unknown> = {};
          if (record.metadata) {
            try { meta = JSON.parse(record.metadata); } catch { /* */ }
          }
          meta.stale_missed_count = 1;

          await (client.from("products") as any)
            .update({ metadata: JSON.stringify(meta) })
            .eq("source", SOURCE)
            .eq("product_url", url);

          firstMissCount++;
          console.log(`[DB] ⚠ First missed run for: "${record.title}" (${url})`);
        } catch { /* */ }
      }
    }

    this.summary.staleDeleted = deletedCount;
    console.log(`[DB] Stale: ${deletedCount} deleted, ${firstMissCount} marked as first miss`);
  }

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------

  printSummary(): void {
    console.log("\n" + "=".repeat(60));
    console.log("  RUN SUMMARY");
    console.log("=".repeat(60));
    console.log(`  🆕  New products:        ${this.summary.newProducts}`);
    console.log(`  🔄  Updated products:    ${this.summary.updatedProducts}`);
    console.log(`  ⏭  Unchanged (skipped): ${this.summary.unchangedProducts}`);
    console.log(`  🗑  Stale deleted:       ${this.summary.staleDeleted}`);
    console.log(`  ❌  Failed:              ${this.summary.failedProducts}`);
    console.log("=".repeat(60));
  }

  getSummary(): RunSummary {
    return { ...this.summary };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
