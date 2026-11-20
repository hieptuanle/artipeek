import { defineConfig } from "drizzle-kit";

// bunx drizzle-kit generate   (after a change to db/schema.ts; the server applies drizzle/ at start)
export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  out: "./drizzle",
});
