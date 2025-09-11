#!/usr/bin/env node

/**
 * Script to remove duplicate website entries from the institutions migration file
 *
 * This script:
 * 1. Parses the SQL migration file to extract institution records
 * 2. Identifies duplicates based on website URLs
 * 3. Keeps the first occurrence and removes subsequent duplicates
 * 4. Updates the SQL file with deduplicated records
 *
 * Usage: node scripts/remove-duplicate-institutions.js
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

/**
 * Parse SQL file to extract institution records with their line information
 */
function parseInstitutionRecords(sqlContent) {
  const records = [];
  const lines = sqlContent.split("\n");

  lines.forEach((line, lineIndex) => {
    // Match institution insert statements - handle escaped quotes and various formats
    const match = line.match(
      /^\s*\(gen_random_uuid\(\), '((?:[^'\\]|\\.)*)', [^,]+, '((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)'/
    );
    if (match) {
      records.push({
        lineNumber: lineIndex + 1,
        fullLine: line,
        name: match[1].replace(/''/g, "'"), // Unescape SQL quotes
        description: match[2].replace(/''/g, "'"),
        website: match[3].replace(/''/g, "'"),
        isLastInSection: line.trim().endsWith(");"), // Check if this is the last line in INSERT
      });
    }
  });

  return records;
}

/**
 * Find duplicate websites
 */
function findDuplicates(records) {
  const websiteMap = new Map();
  const duplicates = [];

  records.forEach((record, index) => {
    if (websiteMap.has(record.website)) {
      // This is a duplicate
      duplicates.push({
        ...record,
        originalIndex: websiteMap.get(record.website),
        duplicateIndex: index,
      });
    } else {
      // First occurrence
      websiteMap.set(record.website, index);
    }
  });

  return duplicates;
}

/**
 * Remove duplicate lines from SQL content
 */
function removeDuplicateLines(sqlContent, duplicateRecords) {
  const lines = sqlContent.split("\n");
  const linesToRemove = new Set();

  // Mark lines for removal
  duplicateRecords.forEach((duplicate) => {
    linesToRemove.add(duplicate.lineNumber - 1); // Convert to 0-based index
  });

  // Filter out the duplicate lines
  const filteredLines = lines.filter(
    (line, index) => !linesToRemove.has(index)
  );

  // Fix trailing commas - ensure proper SQL syntax
  let insideInsertBlock = false;
  const finalLines = [];

  for (let i = 0; i < filteredLines.length; i++) {
    const line = filteredLines[i];
    const nextLine = filteredLines[i + 1];

    // Check if we're inside an INSERT block
    if (line.includes("INSERT INTO institutions")) {
      insideInsertBlock = true;
    }

    if (insideInsertBlock && line.includes("END $$;")) {
      insideInsertBlock = false;
    }

    // If this is an institution record line
    if (insideInsertBlock && line.match(/^\s*\(gen_random_uuid\(\)/)) {
      // Look ahead to find the next institution record line (skipping comments and empty lines)
      let nextInstitutionLine = null;
      for (let j = i + 1; j < filteredLines.length; j++) {
        const lookAheadLine = filteredLines[j];
        if (lookAheadLine.includes("END $$;")) {
          break; // End of insert block
        }
        if (lookAheadLine.match(/^\s*\(gen_random_uuid\(\)/)) {
          nextInstitutionLine = lookAheadLine;
          break;
        }
      }

      const isLastRecord = !nextInstitutionLine;

      if (isLastRecord) {
        // Remove trailing comma and add semicolon for the last record
        finalLines.push(line.replace(/,+\s*$/, ";"));
      } else {
        // Ensure there's exactly one comma for non-last records
        finalLines.push(line.replace(/,*;?\s*$/, ","));
      }
    } else {
      finalLines.push(line);
    }
  }

  return finalLines.join("\n");
}

/**
 * Main execution function
 */
async function main() {
  try {
    console.log("Starting duplicate removal process...\n");

    // Read the SQL file
    console.log("Reading SQL file...");
    const sqlContent = await fs.readFile(SQL_FILE_PATH, "utf-8");

    // Parse institution records
    console.log("Parsing institution records...");
    const records = parseInstitutionRecords(sqlContent);
    console.log(`Found ${records.length} institution records`);

    // Find duplicates
    console.log("Finding duplicates...");
    const duplicates = findDuplicates(records);

    if (duplicates.length === 0) {
      console.log("✅ No duplicates found! The file is already clean.");
      return;
    }

    console.log(`\nFound ${duplicates.length} duplicate records:`);
    duplicates.forEach((duplicate) => {
      const original = records[duplicate.originalIndex];
      console.log(`  🔄 "${duplicate.name}" (${duplicate.website})`);
      console.log(`     Original: line ${original.lineNumber}`);
      console.log(
        `     Duplicate: line ${duplicate.lineNumber} (will be removed)`
      );
    });

    // Create backup
    const backupPath = SQL_FILE_PATH + ".backup." + Date.now();
    await fs.writeFile(backupPath, sqlContent);
    console.log(`\nCreated backup: ${backupPath}`);

    // Remove duplicates
    console.log("Removing duplicate records...");
    const cleanedContent = removeDuplicateLines(sqlContent, duplicates);

    // Write the cleaned file
    await fs.writeFile(SQL_FILE_PATH, cleanedContent);

    // Verify the result
    const newRecords = parseInstitutionRecords(cleanedContent);
    console.log(`\n✅ Duplicate removal completed!`);
    console.log(`  Records before: ${records.length}`);
    console.log(`  Records after: ${newRecords.length}`);
    console.log(`  Removed: ${records.length - newRecords.length} duplicates`);

    // Double-check for remaining duplicates
    const remainingDuplicates = findDuplicates(newRecords);
    if (remainingDuplicates.length > 0) {
      console.log(
        `⚠️  Warning: ${remainingDuplicates.length} duplicates still remain!`
      );
    } else {
      console.log("✅ All duplicates successfully removed!");
    }
  } catch (error) {
    console.error("❌ Error during execution:", error);
    process.exit(1);
  }
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
