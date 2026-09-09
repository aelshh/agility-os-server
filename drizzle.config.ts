import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (!process.env["DATABASE_URL_UNPOOLED"]) {
  throw new Error("DATABASE_URL_UNPOOLED is not set in the .env file");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL_UNPOOLED"],
  },
});
