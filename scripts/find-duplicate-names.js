#!/usr/bin/env node

/**
 * Script to find duplicate institution names in the migration file
 *
 * This script:
 * 1. Parses the SQL migration file to extract institution records
 * 2. Identifies duplicates based on institution names
 * 3. Reports all duplicate names with their details
 *
 * Usage: node scripts/find-duplicate-names.js
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
        fullLine: line.trim(),
        name: match[1].replace(/''/g, "'"), // Unescape SQL quotes
        description: match[2].replace(/''/g, "'"),
        website: match[3].replace(/''/g, "'"),
      });
    }
  });

  return records;
}

/**
 * Find duplicate names
 */
function findDuplicateNames(records) {
  const nameMap = new Map();
  const duplicateGroups = new Map();

  // Group records by name
  records.forEach((record, index) => {
    const normalizedName = record.name.toLowerCase().trim();

    if (!nameMap.has(normalizedName)) {
      nameMap.set(normalizedName, []);
    }
    nameMap.set(normalizedName, [
      ...nameMap.get(normalizedName),
      { ...record, index },
    ]);
  });

  // Find groups with more than one record
  nameMap.forEach((recordGroup, normalizedName) => {
    if (recordGroup.length > 1) {
      duplicateGroups.set(normalizedName, recordGroup);
    }
  });

  return duplicateGroups;
}

/**
 * Display duplicate groups in a readable format
 */
function displayDuplicates(duplicateGroups) {
  if (duplicateGroups.size === 0) {
    console.log("✅ No duplicate names found!");
    return;
  }

  console.log(
    `\n🔍 Found ${duplicateGroups.size} groups with duplicate names:\n`
  );

  let groupNumber = 1;
  duplicateGroups.forEach((records, normalizedName) => {
    console.log(
      `📍 Group ${groupNumber}: "${records[0].name}" (${records.length} occurrences)`
    );
    console.log("─".repeat(60));

    records.forEach((record, index) => {
      console.log(`  ${index + 1}. Line ${record.lineNumber}`);
      console.log(`     Name: "${record.name}"`);
      console.log(
        `     Description: "${record.description.substring(0, 80)}${
          record.description.length > 80 ? "..." : ""
        }"`
      );
      console.log(`     Website: ${record.website}`);
      if (index < records.length - 1) {
        console.log();
      }
    });

    console.log("─".repeat(60));
    console.log();
    groupNumber++;
  });

  // Summary statistics
  const totalDuplicates = Array.from(duplicateGroups.values()).reduce(
    (sum, group) => sum + group.length,
    0
  );
  const extraRecords = totalDuplicates - duplicateGroups.size;

  console.log(`📊 Summary:`);
  console.log(`   • Duplicate groups: ${duplicateGroups.size}`);
  console.log(`   • Total records involved: ${totalDuplicates}`);
  console.log(`   • Extra records (potential for removal): ${extraRecords}`);
}

/**
 * Main execution function
 */
async function main() {
  try {
    console.log("🔍 Searching for duplicate institution names...\n");

    // Read the SQL file
    const sqlContent = await fs.readFile(SQL_FILE_PATH, "utf-8");

    // Parse institution records
    const records = parseInstitutionRecords(sqlContent);
    console.log(`📋 Found ${records.length} institution records total`);

    // Find duplicate names
    const duplicateGroups = findDuplicateNames(records);

    // Display results
    displayDuplicates(duplicateGroups);
  } catch (error) {
    console.error("❌ Error during execution:", error);
    process.exit(1);
  }
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
