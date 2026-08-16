// SQLite-backed key/value persistence, built on the vendored
// connection + transaction-mutex stack (per the project goal of reusing
// mature persistence infrastructure instead of hand-rolling).
//
// Both the reversible-projection refs store and the working-memory scratchpad
// persist through this. It is namespaced (a `ns` column) so one DB file holds
// multiple logical stores. Writes go through withDatabaseTransaction("BEGIN
// IMMEDIATE", …) so concurrent agent lanes sharing the synchronous DatabaseSync
// handle are serialized correctly (concurrency fix).
//
// node:sqlite is experimental on Node 20/22 (emits an ExperimentalWarning) but
// stable enough for this use; if a connection cannot be opened we degrade to a
// no-op so the in-memory layers above keep working.

import type { DatabaseSync } from "node:sqlite"
import { createDatabaseConnection } from "../vendor/db-connection.ts"
import { withDatabaseTransaction } from "../vendor/transaction-mutex.ts"

export interface KvRecord {
	ns: string
	key: string
	value: string
	expiresAtMs: number | null
	updatedAtMs: number
}

interface RawRow {
	value: string
	expires_at_ms: number | null
	updated_at_ms: number
}

export class KvStore {
	private db: DatabaseSync | null = null

	constructor(dbPath: string) {
		try {
			this.db = createDatabaseConnection(dbPath)
			this.db.exec(
				`CREATE TABLE IF NOT EXISTS flowctx_kv (
					ns TEXT NOT NULL,
					key TEXT NOT NULL,
					value TEXT NOT NULL,
					expires_at_ms INTEGER,
					updated_at_ms INTEGER NOT NULL,
					PRIMARY KEY (ns, key)
				)`,
			)
			this.db.exec(`CREATE INDEX IF NOT EXISTS flowctx_kv_ns ON flowctx_kv(ns)`)
		} catch {
			// node:sqlite unavailable or open failed → disable persistence gracefully.
			this.db = null
		}
	}

	get available(): boolean {
		return this.db !== null
	}

	private upsertSql =
		`INSERT INTO flowctx_kv (ns, key, value, expires_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(ns, key) DO UPDATE SET
		   value = excluded.value,
		   expires_at_ms = excluded.expires_at_ms,
		   updated_at_ms = excluded.updated_at_ms`

	/**
	 * Synchronous upsert. DatabaseSync is synchronous, so a single-statement upsert
	 * needs no transaction; callers that need durability before returning use this.
	 */
	putSync(ns: string, key: string, value: string, expiresAtMs: number | null): void {
		const db = this.db
		if (!db) return
		try {
			db.prepare(this.upsertSql).run(ns, key, value, expiresAtMs, Date.now())
		} catch {
			// best-effort persistence
		}
	}

	/**
	 * Async upsert wrapped in the per-DB transaction mutex (concurrency fix
	 * fix) — use when interleaving with other awaited DB work on the shared handle.
	 */
	async put(ns: string, key: string, value: string, expiresAtMs: number | null): Promise<void> {
		const db = this.db
		if (!db) return
		const updatedAtMs = Date.now()
		try {
			await withDatabaseTransaction(db, "BEGIN IMMEDIATE", () => {
				db.prepare(this.upsertSql).run(ns, key, value, expiresAtMs, updatedAtMs)
			})
		} catch {
			// best-effort persistence
		}
	}

	/** Read a value, honoring expiry (expired rows are deleted and return null). */
	get(ns: string, key: string): string | null {
		const db = this.db
		if (!db) return null
		try {
			const row = db.prepare(
				`SELECT value, expires_at_ms, updated_at_ms FROM flowctx_kv WHERE ns = ? AND key = ?`,
			).get(ns, key) as RawRow | undefined
			if (!row) return null
			if (this.isExpired(row.expires_at_ms)) {
				try {
					db.prepare(`DELETE FROM flowctx_kv WHERE ns = ? AND key = ?`).run(ns, key)
				} catch {
					/* best-effort */
				}
				return null
			}
			return row.value
		} catch {
			return null
		}
	}

	/** Load all non-expired rows in a namespace (used to warm an in-memory map). */
	loadNamespace(ns: string): KvRecord[] {
		const db = this.db
		if (!db) return []
		try {
			const stmt = db.prepare(
				`SELECT key, value, expires_at_ms, updated_at_ms FROM flowctx_kv WHERE ns = ?`,
			)
			const out: KvRecord[] = []
			for (const r of stmt.all(ns) as unknown as Array<RawRow & { key: string }>) {
				if (this.isExpired(r.expires_at_ms)) continue
				out.push({
					ns,
					key: r.key,
					value: r.value,
					expiresAtMs: r.expires_at_ms,
					updatedAtMs: r.updated_at_ms,
				})
			}
			return out
		} catch {
			return []
		}
	}

	private isExpired(expiresAtMs: number | null): boolean {
		if (expiresAtMs === null) return false
		return Date.now() >= expiresAtMs
	}
}
