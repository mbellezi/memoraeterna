import { defineConfig } from "drizzle-kit";

const connectionString = process.env.MEMORA_DATABASE_URL ?? "postgresql://memora:memora@127.0.0.1:5432/memora";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString
  },
  strict: true,
  verbose: true
});
