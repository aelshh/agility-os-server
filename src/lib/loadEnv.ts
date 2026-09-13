import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

// Loads server/.env by absolute path so it works regardless of the process
// working directory (dotenv/config alone resolves relative to process.cwd()).
function resolveEnvPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../.env");
}

config({ path: resolveEnvPath() });