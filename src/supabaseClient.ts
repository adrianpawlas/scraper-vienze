/**
 * Supabase client module for importing product data.
 */
import { createClient } from "@supabase/supabase-js";
import { RawProduct } from "./types.js";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || "";

let supabase: ReturnType<typeof createClient> | null = null;

export function getSupabaseClient() {
  if (!supabase) {
    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables"
      );
    }
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}

/**
 * Insert or update a product in the Supabase "products" table.
 * Returns true on success.
 */
export async function upsertProduct(
  product: RawProduct,
  imageEmbedding: number[] | null,
  infoEmbedding: number[] | null
): Promise<boolean> {
  const client = getSupabaseClient();

  // Format price: remove duplicates by currency, prefer EUR
  const priceStr = formatPriceForDb(product.price, product.sale);
  const saleStr = product.sale || null;

  const record = {
    id: product.id,
    source: "scraper-vienze",
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
    country: product.country,
    compressed_image_url: null,
    tags: product.tags.length > 0 ? product.tags : null,
    price: priceStr,
    sale: saleStr,
    additional_images:
      product.additionalImages.length > 0
        ? product.additionalImages.join(" , ")
        : null,
    metadata: JSON.stringify(product.metadata),
    image_embedding: imageEmbedding,
    info_embedding: infoEmbedding,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (client.from("products") as any).upsert(record, {
      onConflict: "id",
      ignoreDuplicates: false,
    });

    if (error) {
      console.error(`[Supabase] Error upserting product ${product.id}:`, error);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[Supabase] Exception upserting product ${product.id}:`, err);
    return false;
  }
}

/**
 * Format price string for database.
 * Ensure consistent formatting and deduplicate currencies.
 */
function formatPriceForDb(price: string, _sale: string | null): string {
  if (!price) return "";

  // Price format is "20.90USD,450CZK,75PLN" — no spaces
  const entries = price.split(",").filter(Boolean);
  const seenCurrencies = new Set<string>();
  const deduped: string[] = [];

  for (const entry of entries) {
    const match = entry.match(/^([\d.]+)([A-Z]{3})$/);
    if (match) {
      const [, amount, currency] = match;
      if (!seenCurrencies.has(currency)) {
        seenCurrencies.add(currency);
        deduped.push(entry);
      }
    } else {
      // Keep as-is if we can't parse
      deduped.push(entry);
    }
  }

  return deduped.join(",");
}

/**
 * Test the Supabase connection.
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("products")
      .select("id")
      .limit(1);

    if (error) {
      console.error("[Supabase] Connection test failed:", error);
      return false;
    }

    console.log(
      `[Supabase] Connection successful. Table "products" exists.`
    );
    return true;
  } catch (err) {
    console.error("[Supabase] Connection test failed:", err);
    return false;
  }
}
