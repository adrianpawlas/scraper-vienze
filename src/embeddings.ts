/**
 * Embeddings module for Vienze scraper.
 * Uses @huggingface/transformers with Xenova/siglip-base-patch16-384
 * to generate 768-dimensional image and text embeddings.
 */
import {
  AutoProcessor,
  SiglipVisionModel,
  AutoTokenizer,
  SiglipTextModel,
  RawImage,
} from "@huggingface/transformers";
import { RawProduct } from "./types.js";

// Singleton model instances
let visionProcessor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;
let visionModel: SiglipVisionModel | null = null;
let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let textModel: SiglipTextModel | null = null;

const MODEL_ID = "Xenova/siglip-base-patch16-384";

/**
 * Initialize the SigLIP models (vision + text).
 * Models are loaded once and reused for all embeddings.
 */
export async function initEmbeddings(): Promise<void> {
  console.log("[Embeddings] Loading SigLIP vision model...");
  visionProcessor = await AutoProcessor.from_pretrained(MODEL_ID);
  visionModel = await SiglipVisionModel.from_pretrained(MODEL_ID);
  console.log("[Embeddings] SigLIP vision model loaded ✓");

  console.log("[Embeddings] Loading SigLIP text model...");
  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  textModel = await SiglipTextModel.from_pretrained(MODEL_ID);
  console.log("[Embeddings] SigLIP text model loaded ✓");
}

/**
 * Generate a 768-dimensional image embedding from a URL.
 */
export async function getImageEmbedding(
  imageUrl: string
): Promise<number[] | null> {
  if (!visionProcessor || !visionModel) {
    throw new Error("Embeddings not initialized. Call initEmbeddings() first.");
  }

  try {
    // Load and process the image
    const image = await RawImage.read(imageUrl);
    const imageInputs = await visionProcessor(image);

    // Generate embedding
    const { pooler_output } = await visionModel(imageInputs);

    // Extract the 768-dimensional vector
    const embedding = Array.from(pooler_output.data as Float32Array);

    if (embedding.length !== 768) {
      console.warn(
        `[Embeddings] Unexpected embedding dimension: ${embedding.length} (expected 768)`
      );
    }

    return embedding;
  } catch (err) {
    console.error(`[Embeddings] Failed to generate image embedding for ${imageUrl}:`, err);
    return null;
  }
}

/**
 * Generate a 768-dimensional text embedding from product information.
 * Builds a comprehensive text string from all product fields.
 */
export async function getTextEmbedding(
  product: RawProduct
): Promise<number[] | null> {
  if (!tokenizer || !textModel) {
    throw new Error("Embeddings not initialized. Call initEmbeddings() first.");
  }

  try {
    // Build comprehensive text description for embedding
    const textParts: string[] = [
      `Title: ${product.title}`,
      product.description ? `Description: ${product.description}` : "",
      product.category ? `Category: ${product.category}` : "",
      product.gender ? `Gender: ${product.gender}` : "",
      product.tags.length > 0 ? `Tags: ${product.tags.join(", ")}` : "",
      product.sizes ? `Sizes: ${product.sizes}` : "",
      product.price ? `Price: ${product.price}` : "",
      product.sale ? `Sale: ${product.sale}` : "",
      product.country ? `Country: ${product.country}` : "",
    ];

    const text = textParts.filter(Boolean).join(". ");

    // Truncate to reasonable length (SigLIP has 64-128 token limit typically)
    const textInputs = tokenizer(text, {
      padding: "max_length",
      truncation: true,
      max_length: 128,
    });

    // Generate embedding
    const { pooler_output } = await textModel(textInputs);

    // Extract the 768-dimensional vector
    const embedding = Array.from(pooler_output.data as Float32Array);

    if (embedding.length !== 768) {
      console.warn(
        `[Embeddings] Unexpected text embedding dimension: ${embedding.length} (expected 768)`
      );
    }

    return embedding;
  } catch (err) {
    console.error(
      `[Embeddings] Failed to generate text embedding for ${product.title}:`,
      err
    );
    return null;
  }
}
