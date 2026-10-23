/**
 * The schema source of T102's replay (F4 D24): every contract's grammar schema, as the MLX adapter
 * derives it in the product (`toGrammarJsonSchema`), for a helper that announces `schema`.
 *
 *   npm run bench:writer -- run --arm m9b4 --schema --schema-module scripts/bench/grammar-schema.ts
 */
import { toGrammarJsonSchema } from "@app/domain";

import type { SchemaSource } from "./contracts/index.ts";

export const schemaForContract: SchemaSource = (_contract, answer) =>
  toGrammarJsonSchema(answer.contract, answer.name);
