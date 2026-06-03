/**
 * Vienze Clothing Scraper - Main Orchestrator
 *
 * Smart flow:
 * 1. Scrape all products
 * 2. Compare against existing DB records
 * 3. Only generate embeddings for new/changed products
 * 4. Batch upsert in groups of 50
 * 5. Handle stale products (delete after 2 missed runs)
 * 6. Print run summary
 */
import "dotenv/config";
import { VienzeScraper } from "./scraper.js";
import { initEmbeddings, getImageEmbedding, getTextEmbedding } from "./embeddings.js";
import { DatabaseManager } from "./supabaseClient.js";
import type { RawProduct } from "./types.js";

const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY || "3", 10);
const DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || "1000", 10);
const MAX_PRODUCTS = parseInt(process.env.MAX_PRODUCTS || "0", 10);
const EMBEDDING_STAGGER_MS = 500; // 0.5s between embedding API calls

async function main() {
  console.log("=".repeat(60));
  console.log("  VIENEZE CLOTHING SCRAPER — SMART MODE");
  console.log("=".repeat(60));
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Delay: ${DELAY_MS}ms`);
  console.log(`  Max products: ${MAX_PRODUCTS > 0 ? MAX_PRODUCTS : "unlimited"}`);
  console.log(`  Batch size: 50`);
  console.log("=".repeat(60));

  // Validate environment early
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.");
    process.exit(1);
  }

  // ====================== Initialize ======================

  console.log("\n[1/6] Testing Supabase connection...");
  const db = new DatabaseManager();
  const connected = await db.testConnection();
  if (!connected) {
    console.error("[FATAL] Cannot connect to Supabase. Aborting.");
    process.exit(1);
  }

  console.log("\n[2/6] Fetching existing products from database...");
  await db.fetchExisting();

  console.log("\n[3/6] Launching browser & initializing embeddings...");
  const scraper = new VienzeScraper(CONCURRENCY, DELAY_MS);
  await scraper.init();

  // Initialize embeddings early (model download happens here)
  console.log("[Embeddings] Loading SigLIP model (may take a few minutes on first run)...");
  await initEmbeddings();
  console.log("[Embeddings] Model ready ✓");

  try {
    // ====================== Discover URLs ======================

    console.log("\n[4/6] Discovering product URLs...");
    const startTime = Date.now();
    const allUrls = await scraper.getAllProductUrls((page, url, count) => {
      console.log(`  [Paginate] Page ${page} | ${url} | Total: ${count}`);
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Paginate] Found ${allUrls.length} URLs in ${elapsed}s ✓`);

    if (allUrls.length === 0) {
      console.warn("[WARN] No products found.");
      return;
    }

    const urlsToScrape =
      MAX_PRODUCTS > 0 ? allUrls.slice(0, MAX_PRODUCTS) : allUrls;

    // Track which URLs were seen (for stale detection)
    const seenUrls = new Set(urlsToScrape);

    // ====================== Scrape Products ======================

    console.log("\n[5/6] Scraping product details...");
    const scrapedProducts: RawProduct[] = [];

    for (let i = 0; i < urlsToScrape.length; i += CONCURRENCY) {
      const chunk = urlsToScrape.slice(i, i + CONCURRENCY);
      const promises = chunk.map(async (url) => {
        try {
          const product = await scraper.scrapeProduct(url);
          if (product) {
            console.log(`  [Scrape] ✓ ${product.title}`);
            return product;
          }
          console.warn(`  [Scrape] ✗ Failed: ${url}`);
          return null;
        } catch (err) {
          console.error(`  [Scrape] ✗ Error: ${url}`, err);
          return null;
        }
      });

      const chunkResults = await Promise.all(promises);
      for (const r of chunkResults) {
        if (r) scrapedProducts.push(r);
      }

      console.log(
        `  Progress: ${Math.min(i + CONCURRENCY, urlsToScrape.length)}/${urlsToScrape.length}`
      );

      if (i + CONCURRENCY < urlsToScrape.length) {
        await delay(DELAY_MS);
      }
    }

    console.log(`\n[Scrape] ${scrapedProducts.length}/${urlsToScrape.length} products scraped ✓`);

    // ====================== Compare & Classify ======================

    console.log("\n[6/6] Classifying products against database...");
    const { decisions, needImageEmbedding, needTextEmbedding } =
      db.processProducts(scrapedProducts);

    const newCount = decisions.filter((d) => d.action === "new").length;
    const changedCount = decisions.filter((d) => d.action === "changed").length;
    const unchangedCount = decisions.filter((d) => d.action === "unchanged").length;

    console.log(`  🆕  New: ${newCount}`);
    console.log(`  🔄  Changed: ${changedCount}`);
    console.log(`  ⏭  Unchanged (skipped): ${unchangedCount}`);
    console.log(`  🖼  Need image embeddings: ${needImageEmbedding.length}`);
    console.log(`  📝  Need text embeddings: ${needTextEmbedding.length}`);

    // ====================== Generate Embeddings ======================

    // Only for products that need them
    const embeddings = new Map<
      string,
      { image: number[] | null; text: number[] | null }
    >();

    // Image embeddings (with stagger)
    if (needImageEmbedding.length > 0) {
      console.log("\n[Embeddings] Generating image embeddings...");
      for (let i = 0; i < needImageEmbedding.length; i++) {
        const product = needImageEmbedding[i];
        process.stdout.write(
          `  [${i + 1}/${needImageEmbedding.length}] ${product.title}... `
        );

        const emb = await getImageEmbedding(product.imageUrl);
        const existing = embeddings.get(product.productUrl) || { image: null, text: null };
        existing.image = emb;
        embeddings.set(product.productUrl, existing);

        console.log(emb ? `✓` : `✗`);

        if (i < needImageEmbedding.length - 1) {
          await delay(EMBEDDING_STAGGER_MS);
        }
      }
    }

    // Text embeddings (with stagger)
    if (needTextEmbedding.length > 0) {
      console.log("\n[Embeddings] Generating text embeddings...");
      for (let i = 0; i < needTextEmbedding.length; i++) {
        const product = needTextEmbedding[i];
        process.stdout.write(
          `  [${i + 1}/${needTextEmbedding.length}] ${product.title}... `
        );

        const emb = await getTextEmbedding(product);
        const existing = embeddings.get(product.productUrl) || { image: null, text: null };
        existing.text = emb;
        embeddings.set(product.productUrl, existing);

        console.log(emb ? `✓` : `✗`);

        if (i < needTextEmbedding.length - 1) {
          await delay(EMBEDDING_STAGGER_MS);
        }
      }
    }

    // ====================== Batch Upsert ======================

    console.log("\n[DB] Upserting products in batches of 50...");
    await db.upsertAll(decisions, embeddings);

    // ====================== Stale Product Cleanup ======================

    await db.handleStaleProducts(seenUrls);

    // ====================== Summary ======================

    db.printSummary();
    console.log(`\n[Done] Scraper finished.`);
  } finally {
    await scraper.close();
    console.log("[Cleanup] Browser closed.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
