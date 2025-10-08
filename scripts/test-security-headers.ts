#!/usr/bin/env bun
/**
 * Test script to verify security headers are properly set
 */

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";

console.log("🔒 Testing Security Headers...\n");
console.log(`Target: ${BACKEND_URL}\n`);

const expectedHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'none'",
  // HSTS only in production
  ...(process.env.NODE_ENV === "production" && {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  }),
};

async function testSecurityHeaders() {
  try {
    // Test the health endpoint with GET method
    const response = await fetch(`${BACKEND_URL}/health`, {
      method: "GET",
    });

    console.log(`Status: ${response.status} ${response.statusText}\n`);

    let allPassed = true;

    for (const [header, expectedValue] of Object.entries(expectedHeaders)) {
      const actualValue = response.headers.get(header);

      if (actualValue === expectedValue) {
        console.log(`✅ ${header}: ${actualValue}`);
      } else if (actualValue) {
        console.log(
          `⚠️  ${header}: Expected "${expectedValue}", got "${actualValue}"`
        );
        allPassed = false;
      } else {
        console.log(`❌ ${header}: MISSING (expected "${expectedValue}")`);
        allPassed = false;
      }
    }

    console.log("\n" + "=".repeat(80));

    if (allPassed) {
      console.log("✅ All security headers are correctly configured!");
      process.exit(0);
    } else {
      console.log("❌ Some security headers are missing or incorrect");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error testing security headers:", error);
    process.exit(1);
  }
}

testSecurityHeaders();
