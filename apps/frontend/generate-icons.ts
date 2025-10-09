// Simple PWA icon generator using Canvas
// Run with: bun run generate-icons.ts

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Simple SVG to use as base
const generateIconSVG = (size: number) => `
<svg width="${size}" height="${size}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#1a1f2e" rx="80"/>
  <g transform="translate(256, 256)">
    <circle cx="0" cy="-40" r="60" fill="#4f46e5" opacity="0.8"/>
    <circle cx="50" cy="20" r="50" fill="#06b6d4" opacity="0.8"/>
    <circle cx="-50" cy="20" r="50" fill="#10b981" opacity="0.8"/>
  </g>
  <text x="256" y="420" font-family="Arial, sans-serif" font-size="80" font-weight="bold" fill="#ffffff" text-anchor="middle">SCANI</text>
</svg>
`;

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const iconsDir = join(import.meta.dir, 'public', 'icons');

console.log('Generating PWA icons as SVG files...');
console.log('Note: For production, convert these to PNG using an image converter.');

sizes.forEach((size) => {
  const svg = generateIconSVG(size);
  const filename = `icon-${size}x${size}.svg`;
  const filepath = join(iconsDir, filename);
  writeFileSync(filepath, svg);
  console.log(`✓ Created ${filename}`);
});

// Also create a master SVG at 512x512
const masterSVG = generateIconSVG(512);
writeFileSync(join(iconsDir, 'icon.svg'), masterSVG);
console.log('✓ Created master icon.svg');

console.log('\nSVG icons created!');
console.log('\nFor production, convert these SVGs to PNG:');
console.log('1. Use an online tool: https://realfavicongenerator.net/');
console.log('2. Or use ImageMagick: convert icon.svg -resize 192x192 icon-192x192.png');
console.log('3. Or use your design tool (Figma, Sketch, etc.)');
