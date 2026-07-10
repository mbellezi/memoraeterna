import type { QueryResultRow } from "pg";

import { mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type {
  IntegrationClientRecord,
  IntegrationClientStatus,
  Queryable
} from "./types.js";

interface IntegrationClientRow extends QueryResultRow {
  id: string;
  clientType: string;
  displayName: string;
  tokenHash: string;
  scopes: unknown;
  capabilities: unknown;
  contractVersion: string;
  status: IntegrationClientStatus;
  lastSeenAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const returning = `id, client_type as "clientType", display_name as "displayName",
  token_hash as "tokenHash", scopes, capabilities, contract_version as "contractVersion",
  status, last_seen_at as "lastSeenAt", created_at as "createdAt", updated_at as "updatedAt"`;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapClient(row: IntegrationClientRow): IntegrationClientRecord {
  return {
    id: row.id,
    clientType: row.clientType,
    displayName: row.displayName,
    tokenHash: row.tokenHash,
    scopes: stringArray(row.scopes),
    capabilities: stringArray(row.capabilities),
    contractVersion: row.contractVersion,
    status: row.status,
    lastSeenAt: mapNullableTimestamp(row.lastSeenAt),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createIntegrationClientRepository(db: Queryable) {
  return {
    async create(input: {
      clientType: string;
      displayName: string;
      tokenHash: string;
      scopes?: string[];
      capabilities?: string[];
      contractVersion: string;
    }): Promise<IntegrationClientRecord> {
      const result = await db.query<IntegrationClientRow>(
        `insert into integration_clients (
           client_type, display_name, token_hash, scopes, capabilities, contract_version
         ) values ($1, $2, $3, $4, $5, $6) returning ${returning}`,
        [
          input.clientType,
          input.displayName,
          input.tokenHash,
          JSON.stringify(input.scopes ?? []),
          JSON.stringify(input.capabilities ?? []),
          input.contractVersion
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Integration client insert returned no row.");
      return mapClient(row);
    },

    async findById(id: string): Promise<IntegrationClientRecord | null> {
      const result = await db.query<IntegrationClientRow>(
        `select ${returning} from integration_clients where id = $1`,
        [id]
      );
      const row = result.rows[0];
      return row ? mapClient(row) : null;
    },

    async findAuthorizedByTokenHash(tokenHash: string): Promise<IntegrationClientRecord | null> {
      const result = await db.query<IntegrationClientRow>(
        `select ${returning} from integration_clients
         where token_hash = $1 and status = 'paired'`,
        [tokenHash]
      );
      const row = result.rows[0];
      return row ? mapClient(row) : null;
    },

    async touch(id: string, input: { capabilities: string[]; contractVersion: string }): Promise<void> {
      await db.query(
        `update integration_clients set capabilities = $2, contract_version = $3,
           last_seen_at = now(), updated_at = now() where id = $1`,
        [id, JSON.stringify(input.capabilities), input.contractVersion]
      );
    },

    async setStatus(id: string, status: IntegrationClientStatus): Promise<IntegrationClientRecord | null> {
      const result = await db.query<IntegrationClientRow>(
        `update integration_clients set status = $2, updated_at = now()
         where id = $1 returning ${returning}`,
        [id, status]
      );
      const row = result.rows[0];
      return row ? mapClient(row) : null;
    },

    async list(): Promise<IntegrationClientRecord[]> {
      const result = await db.query<IntegrationClientRow>(
        `select ${returning} from integration_clients order by created_at desc`
      );
      return result.rows.map(mapClient);
    }
  };
}
