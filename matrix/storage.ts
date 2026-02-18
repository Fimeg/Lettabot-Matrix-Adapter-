/**
 * Matrix Storage
 *
 * SQLite-based storage for room-to-conversation mappings and message tracking.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

interface StorageConfig {
	dataDir: string;
}

export class MatrixStorage {
	private db: Database.Database | null = null;
	private dataDir: string;

	constructor(config: StorageConfig) {
		this.dataDir = config.dataDir;

		// Ensure directory exists
		if (!existsSync(this.dataDir)) {
			mkdirSync(this.dataDir, { recursive: true });
		}
	}

	/**
	 * Initialize the database
	 */
	async init(): Promise<void> {
		const dbPath = join(this.dataDir, "matrix.db");
		this.db = new Database(dbPath);

		// Enable WAL mode for better concurrency
		this.db.pragma("journal_mode = WAL");

		// Create tables
		this.createTables();

		console.log("[MatrixStorage] Database initialized");
	}

	/**
	 * Create database tables
	 */
	private createTables(): void {
		if (!this.db) return;

		// Room to conversation mapping
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_conversations (
        room_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        room_name TEXT,
        is_dm BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

		// Message event mappings for reaction feedback
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_mappings (
        matrix_event_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        step_id TEXT,
        sender TEXT NOT NULL,
        room_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

		// Audio message mappings for TTS regeneration
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS audio_messages (
        audio_event_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        original_text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

		// Create indexes
		this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON message_mappings(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_msg_room ON message_mappings(room_id);
      CREATE INDEX IF NOT EXISTS idx_audio_conv ON audio_messages(conversation_id);
    `);
	}

	/**
	 * Get conversation ID for a room
	 */
	getConversationForRoom(roomId: string): string | null {
		if (!this.db) return null;

		const stmt = this.db.prepare(
			"SELECT conversation_id FROM room_conversations WHERE room_id = ?",
		);
		const result = stmt.get(roomId) as { conversation_id: string } | undefined;
		return result?.conversation_id || null;
	}

	/**
	 * Create conversation for a room
	 */
	createConversationForRoom(
		roomId: string,
		conversationId: string,
		roomName?: string,
		isDm = false,
	): void {
		if (!this.db) return;

		const stmt = this.db.prepare(`
      INSERT INTO room_conversations (room_id, conversation_id, room_name, is_dm)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        room_name = excluded.room_name,
        updated_at = CURRENT_TIMESTAMP
    `);
		stmt.run(roomId, conversationId, roomName || null, isDm ? 1 : 0);
	}

	/**
	 * Store message mapping for reaction tracking
	 */
	storeMessageMapping(
		matrixEventId: string,
		conversationId: string,
		stepId: string | undefined,
		sender: string,
		roomId: string,
	): void {
		if (!this.db) return;

		const stmt = this.db.prepare(`
      INSERT INTO message_mappings (matrix_event_id, conversation_id, step_id, sender, room_id)
      VALUES (?, ?, ?, ?, ?)
    `);
		stmt.run(matrixEventId, conversationId, stepId || null, sender, roomId);
	}

	/**
	 * Get step IDs for a message event
	 */
	getStepIdsForEvent(matrixEventId: string): string[] {
		if (!this.db) return [];

		const stmt = this.db.prepare(
			"SELECT step_id FROM message_mappings WHERE matrix_event_id = ? AND step_id IS NOT NULL",
		);
		const results = stmt.all(matrixEventId) as { step_id: string }[];
		return results.map((r) => r.step_id);
	}

	/**
	 * Store audio message for TTS regeneration
	 */
	storeAudioMessage(
		audioEventId: string,
		conversationId: string,
		roomId: string,
		originalText: string,
	): void {
		if (!this.db) return;

		const stmt = this.db.prepare(`
      INSERT INTO audio_messages (audio_event_id, conversation_id, room_id, original_text)
      VALUES (?, ?, ?, ?)
    `);
		stmt.run(audioEventId, conversationId, roomId, originalText);
	}

	/**
	 * Get original text for audio message
	 */
	getOriginalTextForAudio(audioEventId: string): string | null {
		if (!this.db) return null;

		const stmt = this.db.prepare(
			"SELECT original_text FROM audio_messages WHERE audio_event_id = ?",
		);
		const result = stmt.get(audioEventId) as { original_text: string } | undefined;
		return result?.original_text || null;
	}

	/**
	 * Get all rooms with conversations
	 */
	getAllRooms(): Array<{
		roomId: string;
		conversationId: string;
		roomName: string | null;
		isDm: boolean;
	}> {
		if (!this.db) return [];

		const stmt = this.db.prepare(
			"SELECT room_id, conversation_id, room_name, is_dm FROM room_conversations",
		);
		const results = stmt.all() as Array<{
			room_id: string;
			conversation_id: string;
			room_name: string | null;
			is_dm: number;
		}>;

		return results.map((r) => ({
			roomId: r.room_id,
			conversationId: r.conversation_id,
			roomName: r.room_name,
			isDm: r.is_dm === 1,
		}));
	}

	/**
	 * Close the database
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
}
