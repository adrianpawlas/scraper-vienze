/**
 * Vienze Clothing Scraper - Main Orchestrator
 *
 * Scrapes all products from vienezeclo.com, generates image and text embeddings
 * using SigLIP (Xenova/siglip-base-patch16-384), and imports everything to Supabase.
 */
import "dotenv/config";
import { VienzeScraper } from "./scraper.js";
import { initEmbeddings, getImageEmbedding, getTextEmbedding } from "./embeddings.js";
import { upsertProduct, testConnection } from "./supabaseClient.js";
import { RawProduct } from "./types.js";

const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY || "3", 10);
const DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || "1000", 10);
const MAX_PRODUCTS = parseInt(process.env.MAX_PRODUCTS || "0", 10);

async function main() {
  console.log("=".repeat(60));
  console.log("  VIENEZE CLOTHING SCRAPER");
  console.log("=".repeat(60));
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Delay: ${DELAY_MS}ms`);
  console.log(`  Max products: ${MAX_PRODUCTS > 0 ? MAX_PRODUCTS : "unlimited"}`);
  console.log("=".repeat(60));

  // Step 0: Test connection
  console.log("\n[Step 0] Testing Supabase connection...");
  const connected = await testConnection();
  if (!connected) {
    console.error("[FATAL] Cannot connect to Supabase. Aborting.");
    process.exit(1);
  }
  console.log("[Step 0] Supabase connection OK ✓\n");

  // Step 1: Initialize embeddings
  console.log("[Step 1] Initializing SigLIP embedding models...");
  console.log("[Step 1] This may take a moment (downloading model weights on first run)...");
  await initEmbeddings();
  console.log("[Step 1] Embedding models ready ✓\n");

  // Step 2: Initialize scraper
  console.log("[Step 2] Launching browser...");
  const scraper = new VienzeScraper(CONCURRENCY, DELAY_MS);
  await scraper.init();
  console.log("[Step 2] Browser ready ✓\n");

  try {
    // Step 3: Discover all product URLs
    console.log("[Step 3] Discovering product URLs from all collections...");
    const startTime = Date.now();
    const allUrls = await scraper.getAllProductUrls((page, url, count) => {
      console.log(`  [Paginate] Page ${page} | ${url} | Total URLs: ${count}`);
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Step 3] Found ${allUrls.length} unique product URLs in ${elapsed}s ✓\n`);

    if (allUrls.length === 0) {
      console.warn("[WARN] No product URLs found. Check the website structure.");
      return;
    }

    // Apply max products limit if set
    const urlsToScrape =
      MAX_PRODUCTS > 0 ? allUrls.slice(0, MAX_PRODUCTS) : allUrls;

    if (urlsToScrape.length < allUrls.length) {
      console.log(
        `  (Limited to ${urlsToScrape.length} products due to MAX_PRODUCTS setting)`
      );
    }

    // Step 4: Scrape each product
    console.log("\n[Step 4] Scraping product details...");
    const results: RawProduct[] = [];

    for (let i = 0; i < urlsToScrape.length; i += CONCURRENCY) {
      const chunk = urlsToScrape.slice(i, i + CONCURRENCY);
      const promises = chunk.map(async (url) => {
        try {
          const product = await scraper.scrapeProduct(url);
          if (product) {
            console.log(
              `  [Scrape] ✓ ${product.title} (${product.id})`
            );
            return product;
          } else {
            console.warn(`  [Scrape] ✗ Failed: ${url}`);
            return null;
          }
        } catch (err) {
          console.error(`  [Scrape] ✗ Error: ${url}`, err);
          return null;
        }
      });

      const chunkResults = await Promise.all(promises);
      for (const r of chunkResults) {
        if (r) results.push(r);
      }

      console.log(
        `  Progress: ${Math.min(i + CONCURRENCY, urlsToScrape.length)}/${urlsToScrape.length} products scraped`
      );

      if (i + CONCURRENCY < urlsToScrape.length) {
        await delay(DELAY_MS);
      }
    }

    console.log(
      `\n[Step 4] Scraped ${results.length}/${urlsToScrape.length} products ✓\n`
    );

    // Step 5: Generate embeddings and import to Supabase
    console.log("[Step 5] Generating embeddings & importing to Supabase...\n");
    let imported = 0;
    let failed = 0;

    for (let i = 0; i < results.length; i++) {
      const product = results[i];
      const progress = `[${i + 1}/${results.length}]`;

      console.log(`  ${progress} Processing: ${product.title}`);

      // Generate image embedding
      console.log(`    → Generating image embedding...`);
      const imageEmbedding = await getImageEmbedding(product.imageUrl);

      if (imageEmbedding) {
        console.log(`    → Image embedding: ${imageEmbedding.length} dim ✓`);
      } else {
        console.warn(`    → Image embedding failed ✗`);
      }

      // Generate text embedding
      console.log(`    → Generating text embedding...`);
      const textEmbedding = await getTextEmbedding(product);

      if (textEmbedding) {
        console.log(`    → Text embedding: ${textEmbedding.length} dim ✓`);
      } else {
        console.warn(`    → Text embedding failed ✗`);
      }

      // Import to Supabase
      console.log(`    → Importing to Supabase...`);
      const success = await upsertProduct(product, imageEmbedding, textEmbedding);

      if (success) {
        imported++;
        console.log(`    → Imported ✓`);
      } else {
        failed++;
        console.error(`    → Import failed ✗`);
      }

      // Small delay between upserts to avoid rate limiting
      await delay(200);
    }

    // Final summary
    console.log("\n" + "=".repeat(60));
    console.log("  SCRAPING COMPLETE");
    console.log("=".repeat(60));
    console.log(`  Total URLs discovered: ${allUrls.length}`);
    console.log(`  Products scraped: ${results.length}`);
    console.log(`  Successfully imported: ${imported}`);
    console.log(`  Failed: ${failed}`);
    console.log("=".repeat(60));
  } finally {
    await scraper.close();
    console.log("\nBrowser closed. Done.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
