/**
 * The schema source of T102's replay (F4 D24): every contract's grammar schema, as T99's MLX adapter
 * derived it (`toGrammarJsonSchema` of the contract), for a helper that announces `schema`. It reads
 * no call contract, so it reproduces T99's runs; `grammar-schema-per-call.ts` is today's product.
 *
 *   npm run bench:writer -- run --arm m9b4 --schema --schema-module scripts/bench/grammar-schema.ts
 */
import { toGrammarJsonSchema } from "@app/domain";

import type { SchemaSource } from "./contracts/index.ts";

export const schemaForContract: SchemaSource = (_contract, answer) =>
  toGrammarJsonSchema(answer.contract, answer.name);
