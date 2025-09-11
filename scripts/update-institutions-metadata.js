#!/usr/bin/env node

/**
 * Script to update institution names and descriptions from OpenGraph data
 *
 * This script:
 * 1. Parses the SQL migration file to extract institution records
 * 2. Fetches OpenGraph data from each website
 * 3. Updates the SQL file with correct names and descriptions
 *
 * Usage: node scripts/update-institutions-metadata.js
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const SQL_FILE_PATH = path.join(
  __dirname,
  "../apps/backend/src/db/migrations/0009_seed_institutions.sql"
);
const BATCH_SIZE = 5; // Process 5 websites at a time to avoid rate limiting
const DELAY_BETWEEN_BATCHES = 2000; // 2 seconds delay between batches
const REQUEST_TIMEOUT = 10000; // 10 seconds timeout per request

/**
 * Fetch OpenGraph data from a website
 */
async function fetchOpenGraphData(url) {
  try {
    console.log(`Fetching metadata for: ${url}`);

    // Add https:// if not present
    const fullUrl = url.startsWith("https")
      ? url
      : `https://${url.replace("http://", "")}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(fullUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // Extract OpenGraph data
    const ogTitle =
      extractMetaContent(html, "og:title") ||
      extractMetaContent(html, "twitter:title");
    const ogDescription =
      extractMetaContent(html, "og:description") ||
      extractMetaContent(html, "twitter:description") ||
      extractMetaContent(html, "description");
    const title = ogTitle || extractTitleTag(html);

    // Clean up the data
    const cleanTitle = cleanString(title);
    const cleanDescription = cleanString(ogDescription);

    return {
      title: cleanTitle,
      description: cleanDescription,
      success: true,
    };
  } catch (error) {
    console.error(`Failed to fetch metadata for ${url}:`, error.message);
    return {
      title: null,
      description: null,
      success: false,
      error: error.message,
    };
  }
}

/**
 * Extract meta content from HTML
 */
function extractMetaContent(html, property) {
  const patterns = [
    new RegExp(
      `<meta\\s+property=["']${property}["']\\s+content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta\\s+content=["']([^"']+)["']\\s+property=["']${property}["']`,
      "i"
    ),
    new RegExp(
      `<meta\\s+name=["']${property}["']\\s+content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta\\s+content=["']([^"']+)["']\\s+name=["']${property}["']`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Extract title tag from HTML
 */
function extractTitleTag(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1] : null;
}

/**
 * Clean and normalize strings
 */
function cleanString(str) {
  if (!str) return null;

  return (
    str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      // Remove common suffixes
      .replace(/\s*\|\s*.*$/, "") // Remove "| Company Name" patterns
      .replace(/\s*-\s*.*$/, "") // Remove "- Company Name" patterns
      .trim()
  );
}

/**
 * Parse SQL file to extract institution records
 */
function parseInstitutionRecords(sqlContent) {
  const records = [];

  // Find all INSERT statements for institutions
  const insertMatches = sqlContent.match(
    /\(gen_random_uuid\(\), '([^']+)', [^,]+, '([^']*)', '([^']+)', [^)]+\)/g
  );

  if (insertMatches) {
    insertMatches.forEach((match, index) => {
      const parts = match.match(
        /\(gen_random_uuid\(\), '([^']+)', [^,]+, '([^']*)', '([^']+)', [^)]+\)/
      );
      if (parts) {
        records.push({
          index,
          originalMatch: match,
          name: parts[1],
          description: parts[2],
          website: parts[3],
          line: null, // We'll find this later if needed
        });
      }
    });
  }

  return records;
}

/**
 * Update SQL content with new metadata
 */
function updateSqlContent(sqlContent, records, metadataMap) {
  let updatedContent = sqlContent;

  records.forEach((record) => {
    const metadata = metadataMap[record.website];
    if (metadata && metadata.success) {
      let newName = record.name;
      let newDescription = record.description;

      // Update name if we got a better one
      if (
        metadata.title &&
        metadata.title.length > 0 &&
        metadata.title.length < 100
      ) {
        newName = metadata.title;
      }

      // Update description if we got one
      if (
        metadata.description &&
        metadata.description.length > 0 &&
        metadata.description.length < 500
      ) {
        newDescription = metadata.description;
      }

      // Create the replacement string
      const newMatch = record.originalMatch
        .replace(`'${record.name}'`, `'${newName.replace(/'/g, "''")}'`)
        .replace(
          `'${record.description}'`,
          `'${newDescription.replace(/'/g, "''")}'`
        );

      // Replace in content
      updatedContent = updatedContent.replace(record.originalMatch, newMatch);

      console.log(`Updated: ${record.name} -> ${newName}`);
      if (record.description !== newDescription) {
        console.log(`  Description: ${newDescription.substring(0, 100)}...`);
      }
    }
  });

  return updatedContent;
}

/**
 * Sleep function for delays
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main execution function
 */
async function main() {
  try {
    console.log("Starting institution metadata update...\n");

    // Read the SQL file
    console.log("Reading SQL file...");
    const sqlContent = await fs.readFile(SQL_FILE_PATH, "utf-8");

    // Parse institution records
    console.log("Parsing institution records...");
    const records = parseInstitutionRecords(sqlContent);
    console.log(`Found ${records.length} institution records\n`);

    // Get unique websites
    const websites = [...new Set(records.map((r) => r.website))];
    console.log(`Found ${websites.length} unique websites\n`);

    // Fetch metadata in batches
    const metadataMap = {};

    for (let i = 0; i < websites.length; i += BATCH_SIZE) {
      const batch = websites.slice(i, i + BATCH_SIZE);
      console.log(
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
          websites.length / BATCH_SIZE
        )}`
      );

      const promises = batch.map((website) =>
        fetchOpenGraphData(website).then((result) => ({ website, result }))
      );

      const results = await Promise.all(promises);

      results.forEach(({ website, result }) => {
        metadataMap[website] = result;
      });

      console.log(
        `Completed batch. Successful: ${
          results.filter((r) => r.result.success).length
        }/${batch.length}\n`
      );

      // Delay between batches
      if (i + BATCH_SIZE < websites.length) {
        console.log(
          `Waiting ${DELAY_BETWEEN_BATCHES}ms before next batch...\n`
        );
        await sleep(DELAY_BETWEEN_BATCHES);
      }
    }

    // Summary of fetched data
    const successful = Object.values(metadataMap).filter(
      (m) => m.success
    ).length;
    const failed = Object.values(metadataMap).filter((m) => !m.success).length;

    console.log(`\nMetadata fetch summary:`);
    console.log(`  Successful: ${successful}`);
    console.log(`  Failed: ${failed}`);

    if (failed > 0) {
      console.log(`\nFailed websites:`);
      Object.entries(metadataMap)
        .filter(([_, metadata]) => !metadata.success)
        .forEach(([website, metadata]) => {
          console.log(`  ${website}: ${metadata.error}`);
        });
    }

    // Update SQL content
    console.log("\nUpdating SQL content...");
    const updatedSqlContent = updateSqlContent(
      sqlContent,
      records,
      metadataMap
    );

    // Create backup
    const backupPath = SQL_FILE_PATH + ".backup." + Date.now();
    await fs.writeFile(backupPath, sqlContent);
    console.log(`Created backup: ${backupPath}`);

    // Write updated file
    await fs.writeFile(SQL_FILE_PATH, updatedSqlContent);
    console.log(`Updated SQL file: ${SQL_FILE_PATH}`);

    console.log("\n✅ Institution metadata update completed!");
  } catch (error) {
    console.error("❌ Error during execution:", error);
    process.exit(1);
  }
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
