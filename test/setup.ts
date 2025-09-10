import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeEach, afterEach } from "bun:test";

// Only register happy-dom for frontend tests
const isBackendTest =
  process.cwd().includes("/apps/backend") ||
  Bun.main.includes("/apps/backend") ||
  process.argv.some((arg) => arg.includes("/apps/backend"));

if (!isBackendTest) {
  beforeEach(() => {
    GlobalRegistrator.register();
  });
  afterEach(() => {
    GlobalRegistrator.unregister();
  });
}
