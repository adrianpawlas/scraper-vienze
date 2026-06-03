import { chromium, Browser, Page } from "playwright";
import type { RawProduct } from "./types.js";

const BASE_URL = "https://vienezeclo.com";
const COLLECTION_URLS = [
  `${BASE_URL}/collections/all-products`,
  `${BASE_URL}/collections/sale`,
];
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ====================== Pure Node.js helpers ======================

function toPrice(v: string | number | undefined | null): number {
  if (v == null) return 0;
  if (typeof v === "number") return v > 1000 ? v / 100 : v;
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  if (!v.includes(".") && n > 1000) return n / 100;
  return n;
}

function inferGender(title: string, desc: string): string | null {
  const all = [title, desc].join(" ").toLowerCase();
  if (/women|female/.test(all)) return "women";
  if (/men|male/.test(all)) return "men";
  return "unisex";
}

function inferCategory(title: string): string {
  const map: Record<string, string[]> = {
    "T-Shirts": ["t-shirt", "t shirt", "tee", "shirt"],
    Sweaters: ["sweater", "jumper", "pullover"],
    Hoodies: ["hoodie", "hoody"],
    Sweatpants: ["sweatpant", "sweat pant", "jogger", "pants"],
    Jackets: ["jacket", "bomber", "coat", "flannel"],
    Accessories: ["cap", "hat", "beanie", "snapback", "trucker", "pillbox"],
    Longsleeves: ["longsleeve", "long sleeve"],
  };
  const lower = title.toLowerCase();
  return (
    Object.entries(map)
      .filter(([, kw]) => kw.some((k) => lower.includes(k)))
      .map(([c]) => c)
      .join(", ") || "Other"
  );
}

// ====================== Parse from raw server HTML ======================

interface ParsedVariants {
  variants: Array<{
    price: number;
    compareAtPrice: number | null;
    options: string[];
    title: string;
    available: boolean;
  }>;
  currency: string;
}

/**
 * Extract Shopify variant data from the raw server HTML.
 * The variants are embedded in an anonymous <script type="application/json"> tag.
 */
function parseVariantsFromHtml(html: string): ParsedVariants | null {
  if (!html) return null;

  // Find anonymous application/json script containing variant data (starts with [)
  const jsonRegex = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = jsonRegex.exec(html)) !== null) {
    const text = match[1].trim();
    if (text.startsWith("[") && text.includes("option1") && text.includes("price")) {
      try {
        const data = JSON.parse(text);
        if (Array.isArray(data) && data.length > 0) {
          const variants = data.map((v: Record<string, unknown>) => ({
            price: toPrice(v.price as number),
            compareAtPrice: v.compare_at_price != null ? toPrice(v.compare_at_price as number) : null,
            options: [v.option1, v.option2, v.option3].filter(Boolean) as string[],
            title: (v.title as string) || "",
            available: (v.available as boolean) ?? false,
          }));
          return { variants, currency: "EUR" };
        }
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}

/**
 * Parse the schema.org Product data from the raw server HTML.
 * This captures EUR prices BEFORE the client-side currency converter modifies them.
 */
function parseSchemaFromHtml(html: string): Record<string, unknown> | null {
  if (!html) return null;

  const schemaRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = schemaRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      if (data["@type"] === "Product") {
        return {
          name: data.name,
          description: data.description,
          image: data.image,
          offers: data.offers,
          brand: data.brand?.name,
          url: data.url,
          sku: data.sku,
        };
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

// ====================== Browser-side evaluate strings ======================

const EVAL_PRODUCT_LINKS = `
  (() => {
    const links = [];
    for (const a of document.querySelectorAll("a")) {
      const h = a.href;
      if (h && h.includes("/products/") && !links.includes(h)) links.push(h);
    }
    return links;
  })()
`;

const EVAL_IMAGES = `
  (() => {
    const urls = [];
    for (const img of document.querySelectorAll('img[src*="cdn.shopify.com"], img[data-src*="cdn.shopify.com"]')) {
      let src = img.src || img.getAttribute("data-src") || "";
      if (src) {
        src = src.replace(/\\?_ex=\\d+/g, "").replace(/\\?v=\\d+/g, "");
        if (src.startsWith("//")) src = "https:" + src;
        if (!urls.includes(src)) urls.push(src);
      }
    }
    return urls;
  })()
`;

// ====================== Scraper ======================

export class VienzeScraper {
  private browser: Browser | null = null;
  private concurrency: number;
  private delayMs: number;

  constructor(concurrency = 3, delayMs = 1000) {
    this.concurrency = concurrency;
    this.delayMs = delayMs;
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close();
    this.browser = null;
  }

  // --- Pagination ---

  async getAllProductUrls(onProgress?: (p: number, u: string, c: number) => void): Promise<string[]> {
    const allUrls = new Set<string>();
    for (const colUrl of COLLECTION_URLS) {
      let pageNum = 1;
      while (true) {
        const url = pageNum === 1 ? colUrl : `${colUrl}?page=${pageNum}`;
        console.log(`[Paginator] ${url}`);
        onProgress?.(pageNum, colUrl, allUrls.size);
        const page = await this.makePage();
        try {
          await page.goto(url, { waitUntil: "load", timeout: 30000 });
          await delay(2000);
          const links: string[] = await page.evaluate(EVAL_PRODUCT_LINKS);
          if (links.length === 0) {
            console.log(`[Paginator] No products — done`);
            await page.close();
            break;
          }
          for (const l of links) allUrls.add(l);
          console.log(`[Paginator] Page ${pageNum}: ${links.length} products (total: ${allUrls.size})`);
          await page.close();
          pageNum++;
          await delay(this.delayMs);
        } catch (err) {
          console.error(`[Paginator] Error:`, err);
          await page.close();
          break;
        }
      }
    }
    return Array.from(allUrls);
  }

  // --- Single product ---

  async scrapeProduct(url: string): Promise<RawProduct | null> {
    const page = await this.makePage();
    let rawHtml = "";

    // Intercept raw HTML response before JS modifies it
    const onResponse = async (response: { url: () => string; headers: () => Record<string, string>; text: () => Promise<string> }) => {
      if (
        response.url() === url &&
        (response.headers()["content-type"] || "").includes("text/html")
      ) {
        try {
          rawHtml = await response.text();
        } catch {
          /* ignore */
        }
      }
    };

    page.on("response", onResponse);

    try {
      // Single navigation — intercept the server HTML during load
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await delay(2000);

      // Parse raw data from server HTML (EUR prices, variants, sizes)
      const schemaEur = parseSchemaFromHtml(rawHtml);
      const parsedVariants = parseVariantsFromHtml(rawHtml);

      // Extract images and titles from rendered page
      const imageUrls: string[] = await page.evaluate(EVAL_IMAGES);
      const pageTitle = await page.title();

      return this.buildProduct(url, schemaEur, parsedVariants, imageUrls, pageTitle);
    } catch (err) {
      console.error(`[Scraper] Error: ${url}`, err);
      return null;
    } finally {
      page.removeListener("response", onResponse);
      await page.close();
    }
  }

  // --- Product builder ---

  private buildProduct(
    productUrl: string,
    schemaEur: Record<string, unknown> | null,
    parsedVariants: ParsedVariants | null,
    imageUrls: string[],
    pageTitle: string,
  ): RawProduct | null {
    // Title
    const title = (schemaEur?.name as string) || pageTitle.replace(/ – VIENEZE$/i, "").trim() || "";
    if (!title) return null;

    // Description
    const description = (schemaEur?.description as string) || "";

    // Images
    const schemaImgs = schemaEur?.image;
    const schemaImgList = Array.isArray(schemaImgs)
      ? (schemaImgs as string[])
      : schemaImgs ? [schemaImgs as string] : [];

    const cleanUrls = (urls: string[]) =>
      urls.map((u) => u.replace(/&width=\d+/g, "").replace(/\?v=\d+/g, ""));

    const allImages = [...new Set([...cleanUrls(imageUrls), ...cleanUrls(schemaImgList)])];
    const primaryImage = allImages[0] || "";
    const additionalImages = allImages.slice(1);

    // Price from schema.org offers (EUR server-rendered)
    const offers = schemaEur?.offers;
    const offerList = Array.isArray(offers) ? (offers as Array<Record<string, unknown>>) : [];

    let priceStr = "";
    let saleStr: string | null = null;
    let onSale = false;

    if (offerList.length > 0) {
      const pricesByCurrency = new Map<string, number>();
      for (const offer of offerList) {
        const p = toPrice(offer.price as string | number | null | undefined);
        const c = (offer.priceCurrency as string) || "EUR";
        if (p > 0) pricesByCurrency.set(c, Math.max(pricesByCurrency.get(c) || 0, p));
      }
      priceStr = Array.from(pricesByCurrency.entries())
        .map(([cur, amt]) => amt.toFixed(2).replace(/\.?0+$/, "") + cur)
        .join(",");
    }

    // Sale detection from variant compare_at_price
    // When on sale: schema offers have the SALE price, variants' compare_at_price has the ORIGINAL price
    if (parsedVariants) {
      for (const v of parsedVariants.variants) {
        if (v.compareAtPrice != null && v.compareAtPrice > v.price && v.compareAtPrice > 0) {
          onSale = true;
          // Sale price = variant's current price (same as schema price)
          saleStr = v.price.toFixed(2).replace(/\.?0+$/, "") + parsedVariants.currency;
          // Original price = variant's compare_at_price
          const originalPrice = v.compareAtPrice.toFixed(2).replace(/\.?0+$/, "") + parsedVariants.currency;
          priceStr = originalPrice;
          break;
        }
      }
    }

    // Sizes from variant options
    const sizeSet = new Set<string>();
    if (parsedVariants) {
      for (const v of parsedVariants.variants) {
        for (const opt of v.options) {
          if (
            opt &&
            typeof opt === "string" &&
            !opt.toLowerCase().includes("default") &&
            opt.length < 25
          ) {
            sizeSet.add(opt);
          }
        }
      }
    }

    // Tags from schema brand + offers info
    const tags: string[] = [];
    if (schemaEur?.brand) tags.push(String(schemaEur.brand));

    // Category
    const category = inferCategory(title);

    // Gender
    const gender = inferGender(title, description);

    // ID
    const id = productUrl.split("/products/").pop() || productUrl;

    // Metadata
    const metadata: Record<string, unknown> = {
      title,
      description,
      currency: "EUR",
      onSale,
      offersCount: offerList.length,
      variantsCount: parsedVariants?.variants.length || 0,
      sizes: Array.from(sizeSet),
    };

    return {
      id,
      productUrl,
      imageUrl: primaryImage,
      additionalImages,
      title,
      description,
      category,
      gender,
      price: priceStr || (onSale && saleStr ? saleStr : ""),
      sale: saleStr,
      sizes: Array.from(sizeSet).join(", "),
      tags,
      metadata,
      onSale,
      prices: [],
      salePrices: null,
      shopifyData: {},
      country: null,
    } as RawProduct;
  }

  private async makePage(): Promise<Page> {
    if (!this.browser) throw new Error("Browser not initialized");
    const ctx = await this.browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
    });
    return await ctx.newPage();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
