/**
 * IndexedDB Polyfill for Node.js — Persistent SQLite Backend
 *
 * Uses indexeddbshim (backed by sqlite3) to provide a REAL persistent IndexedDB
 * implementation. Crypto keys, sessions, and device state are written to SQLite
 * databases in databaseDir and survive process restarts.
 *
 * This replaces the previous fake-indexeddb (in-memory only) approach.
 * With persistence, the bot keeps the same device identity across restarts —
 * no re-verification needed after code changes.
 *
 * Storage: {databaseDir}/*.db (one SQLite file per IDB database name)
 */

import { existsSync, mkdirSync } from "node:fs";

interface PolyfillOptions {
	databaseDir: string;
}

let initialized = false;

/**
 * Initialize IndexedDB polyfill with persistent SQLite backend
 *
 * @param options.databaseDir - Directory where SQLite .db files are stored
 */
export async function initIndexedDBPolyfill(options: PolyfillOptions): Promise<void> {
	if (initialized) {
		console.log("[IndexedDB] Polyfill already initialized");
		return;
	}

	const { databaseDir } = options;

	// Ensure directory exists
	if (!existsSync(databaseDir)) {
		mkdirSync(databaseDir, { recursive: true });
	}

	try {
		// indexeddbshim v16 — SQLite-backed IndexedDB for Node.js
		// Sets global.indexedDB, global.IDBKeyRange, etc.
		const { default: setGlobalVars } = await import("indexeddbshim/src/node.js");

		setGlobalVars(null, {
			checkOrigin: false,          // no origin checks in Node.js
			databaseBasePath: databaseDir, // where SQLite .db files live
			deleteDatabaseFiles: false,   // preserve data across restarts
		});

		initialized = true;
		console.log(`[IndexedDB] Persistent SQLite backend initialized at ${databaseDir}`);
		console.log("[IndexedDB] Crypto state will survive process restarts");
	} catch (err) {
		console.error("[IndexedDB] Failed to initialize persistent backend:", err);
		console.warn("[IndexedDB] Falling back to fake-indexeddb (in-memory, ephemeral)");

		try {
			// @ts-expect-error - no types for auto import
			await import("fake-indexeddb/auto");
			initialized = true;
			console.log("[IndexedDB] Fallback: in-memory IndexedDB (keys lost on restart)");
		} catch (fallbackErr) {
			console.error("[IndexedDB] Fallback also failed:", fallbackErr);
		}
	}
}

/**
 * Check if IndexedDB polyfill is available
 */
export function isIndexedDBAvailable(): boolean {
	return initialized && typeof (global as any).indexedDB !== "undefined";
}
