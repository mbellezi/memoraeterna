/**
 * The schema source of the per-call grammar replay (F4 D24, after T99's): the grammar schema exactly
 * as the product's MLX adapter derives it (`grammarSchemaForContract`), so a confirmation or typing
 * call is decoded under its own rows' or pairs' schema (the `callContract` its flow states) and every
 * other contract under its static grammar, as with `grammar-schema.ts`.
 *
 *   npm run bench:writer -- run --arm m9b4 --schema --schema-module scripts/bench/grammar-schema-per-call.ts
 */
import { grammarSchemaForContract } from "@app/domain";

import type { SchemaSource } from "./contracts/index.ts";

export const schemaForContract: SchemaSource = (_contract, answer) =>
  grammarSchemaForContract(answer);
