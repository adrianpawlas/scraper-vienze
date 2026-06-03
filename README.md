# Vienze Clothing Scraper

Scrapes all products from [vienezeclo.com](https://vienezeclo.com), generates 768-dimensional SigLIP image and text embeddings, and imports everything to a Supabase database.

## Automated Runs

The scraper runs via GitHub Actions:
- **Scheduled**: Every Monday at 7:30 PM UTC
- **Manual**: Trigger from the [Actions tab](https://github.com/adrianpawlas/scraper-vienze/actions) — click "Run workflow" and optionally set a product limit

## Setup

### 1. Configure GitHub Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `SUPABASE_URL` | `https://yqawmzggcgpeyaaynrjk.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Your Supabase service role key |

### 2. Run Locally

```bash
# Install dependencies
npm install

# Install Playwright browser
npx playwright install chromium

# Copy .env.example to .env and fill in your Supabase credentials
SUPABASE_URL=your_url SUPABASE_SERVICE_KEY=your_key npx tsx src/index.ts

# Or limit to N products
MAX_PRODUCTS=5 npx tsx src/index.ts
```

## Project Structure

```
src/
  scraper.ts        # Playwright-based Shopify scraper
  embeddings.ts     # SigLIP 768-dim image + text embeddings
  supabaseClient.ts # Supabase upsert operations
  index.ts          # Main orchestrator
  types.ts          # TypeScript interfaces
.github/
  workflows/
    scrape.yml      # GitHub Actions automation
```

## Database

The scraper expects a `products` table in Supabase with the schema defined in the project requirements.
