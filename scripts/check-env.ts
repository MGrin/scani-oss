#!/usr/bin/env bun

/**
 * Environment Variable Setup Verification
 *
 * This script checks if all required environment variables are properly configured
 * for the Scani application. Run this before starting the app to ensure proper setup.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const BOLD = '\x1b[1m';

console.log(`${BOLD}${BLUE}🔍 Scani Environment Setup Verification${RESET}\n`);

let allValid = true;

// Check backend environment variables
console.log(`${BOLD}Backend Environment Variables:${RESET}`);

const backendEnvPath = join(process.cwd(), 'apps/backend/.env.local');
const hasBackendEnv = existsSync(backendEnvPath);

if (!hasBackendEnv) {
  console.log(`${RED}❌ Missing apps/backend/.env.local file${RESET}`);
  console.log(`${YELLOW}   Copy apps/backend/.env.example to apps/backend/.env.local${RESET}`);
  allValid = false;
} else {
  console.log(`${GREEN}✅ Found apps/backend/.env.local${RESET}`);
}

// Check frontend environment variables
console.log(`\n${BOLD}Frontend Environment Variables:${RESET}`);

const frontendEnvPath = join(process.cwd(), 'apps/frontend/.env.local');
const hasFrontendEnv = existsSync(frontendEnvPath);

if (!hasFrontendEnv) {
  console.log(`${RED}❌ Missing apps/frontend/.env.local file${RESET}`);
  console.log(`${YELLOW}   Copy apps/frontend/.env.example to apps/frontend/.env.local${RESET}`);
  allValid = false;
} else {
  console.log(`${GREEN}✅ Found apps/frontend/.env.local${RESET}`);
}

// Check if .env.example files exist (they should)
console.log(`\n${BOLD}Example Files:${RESET}`);
const backendExamplePath = join(process.cwd(), 'apps/backend/.env.example');
const frontendExamplePath = join(process.cwd(), 'apps/frontend/.env.example');

if (existsSync(backendExamplePath)) {
  console.log(`${GREEN}✅ apps/backend/.env.example${RESET}`);
} else {
  console.log(`${RED}❌ Missing apps/backend/.env.example${RESET}`);
}

if (existsSync(frontendExamplePath)) {
  console.log(`${GREEN}✅ apps/frontend/.env.example${RESET}`);
} else {
  console.log(`${RED}❌ Missing apps/frontend/.env.example${RESET}`);
}

// Provide setup instructions
console.log(`\n${BOLD}Setup Instructions:${RESET}`);
console.log(`1. Create a Supabase project at ${BLUE}https://supabase.com${RESET}`);
console.log(`2. Enable Email/Password authentication in Supabase Dashboard`);
console.log(`3. Copy your project URL and keys from Supabase Dashboard > Settings > API`);
console.log(`4. Copy the example environment files and add your Supabase credentials:`);

if (!hasBackendEnv) {
  console.log(`   ${YELLOW}cp apps/backend/.env.example apps/backend/.env.local${RESET}`);
}
if (!hasFrontendEnv) {
  console.log(`   ${YELLOW}cp apps/frontend/.env.example apps/frontend/.env.local${RESET}`);
}

console.log(`5. Edit the .env.local files with your actual Supabase values`);
console.log(`6. Run ${GREEN}bun dev${RESET} to start the application`);

// Final result
console.log(`\n${BOLD}Result:${RESET}`);
if (allValid) {
  console.log(`${GREEN}✅ Environment setup looks good!${RESET}`);
  console.log(`${GREEN}You can now run 'bun dev' to start the application.${RESET}`);
} else {
  console.log(`${RED}❌ Environment setup incomplete.${RESET}`);
  console.log(`${YELLOW}Please follow the setup instructions above.${RESET}`);
  process.exit(1);
}
