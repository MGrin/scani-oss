#!/usr/bin/env node

/**
 * PWA Icon Generator
 *
 * This script generates PNG icons from the SVG source for PWA usage.
 * It also creates a multi-resolution favicon.ico file.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PUBLIC_DIR = join(__dirname, '../public');
const ICONS_DIR = join(PUBLIC_DIR, 'icons');
const SVG_SOURCE = join(ICONS_DIR, 'icon.svg');

// Ensure icons directory exists
if (!existsSync(ICONS_DIR)) {
  mkdirSync(ICONS_DIR, { recursive: true });
}

// Icon sizes to generate
const ICON_SIZES = [72, 96, 128, 144, 152, 180, 192, 384, 512];
const FAVICON_SIZES = [16, 32, 48];

console.log('🎨 Generating PWA icons from SVG...\n');

async function generateIcons() {
  try {
    // Read the SVG source
    const svgBuffer = readFileSync(SVG_SOURCE);

    console.log('📦 Generating PNG icons:');

    // Generate PNG icons
    for (const size of ICON_SIZES) {
      const outputPath = join(ICONS_DIR, `icon-${size}x${size}.png`);

      await sharp(svgBuffer)
        .resize(size, size, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toFile(outputPath);

      console.log(`  ✓ Generated ${size}x${size} icon`);
    }

    console.log('\n🖼️  Generating favicon.ico:');

    // Generate favicon sizes as PNGs first
    const faviconBuffers = [];
    for (const size of FAVICON_SIZES) {
      const buffer = await sharp(svgBuffer)
        .resize(size, size, {
          fit: 'contain',
          background: { r: 26, g: 31, b: 46, alpha: 1 }, // #1a1f2e background
        })
        .png()
        .toBuffer();

      faviconBuffers.push(buffer);
      console.log(`  ✓ Generated ${size}x${size} favicon layer`);
    }

    // For favicon.ico, we'll create the largest size (48x48) as a standalone
    // True multi-resolution .ico creation requires additional libraries,
    // so we'll create a simple 32x32 PNG-based favicon
    const faviconPath = join(PUBLIC_DIR, 'favicon.ico');
    await sharp(svgBuffer)
      .resize(32, 32, {
        fit: 'contain',
        background: { r: 26, g: 31, b: 46, alpha: 1 },
      })
      .png()
      .toFile(faviconPath);

    console.log('  ✓ Generated favicon.ico (32x32 PNG format)\n');

    // Also create explicit favicon PNGs
    console.log('🔖 Generating explicit favicon PNGs:');
    for (const size of [16, 32]) {
      const outputPath = join(PUBLIC_DIR, `favicon-${size}x${size}.png`);
      await sharp(svgBuffer)
        .resize(size, size, {
          fit: 'contain',
          background: { r: 26, g: 31, b: 46, alpha: 1 },
        })
        .png()
        .toFile(outputPath);

      console.log(`  ✓ Generated favicon-${size}x${size}.png`);
    }

    console.log('\n✨ Icon generation complete!');
    console.log(`\n📁 Icons saved to: ${ICONS_DIR}`);
    console.log(`📁 Favicon saved to: ${PUBLIC_DIR}\n`);
  } catch (error) {
    console.error('❌ Error generating icons:', error);
    process.exit(1);
  }
}

generateIcons();
