/**
 * Matrix Adapter - Main Implementation
 */

import type { ChannelAdapter } from "../types.js";
import type { InboundMessage, OutboundMessage } from "../../core/types.js";
import * as sdk from "matrix-js-sdk";
import { RoomMemberEvent, RoomEvent, ClientEvent } from "matrix-js-sdk";

import { MatrixSessionManager } from "./session.js";
import { initE2EE, getCryptoCallbacks, checkAndRestoreKeyBackup } from "./crypto.js";
import { formatMatrixHTML } from "./html-formatter.js";
import { handleTextMessage, checkAccess } from "./handlers/message.js";
import { handleMembershipEvent } from "./handlers/invite.js";
import { handleReactionEvent } from "./handlers/reaction.js";
import { handleAudioMessage } from "./handlers/audio.js";
import { handleImageMessage } from "./handlers/image.js";
import { isUserAllowed, upsertPairingRequest } from "../../pairing/store.js";
import { synthesizeSpeech } from "./tts.js";
import { MatrixVerificationHandler } from "./verification.js";
type VerificationRequest = sdk.Crypto.VerificationRequest;

import type { MatrixAdapterConfig } from "./types.js";
import { DEFAULTS, SPECIAL_REACTIONS } from "./types.js";
import { MsgType } from "matrix-js-sdk";
import { MatrixStorage } from "./storage.js";

// Content types for Matrix events (using any to avoid import issues)
type RoomMessageEventContent = any;
type ReactionEventContent = any;

export class MatrixAdapter implements ChannelAdapter {
  readonly id = "matrix" as const;
  readonly name = "Matrix";

  private config: Required<Omit<MatrixAdapterConfig, "password" | "accessToken" | "deviceId" | "recoveryKey" | "sttUrl" | "ttsUrl" | "messagePrefix" | "pantalaimonUrl" | "userDeviceId">> & {
    password?: string;
    accessToken?: string;
    deviceId?: string;
    recoveryKey?: string;
    sttUrl?: string;
    ttsUrl?: string;
    messagePrefix?: string;
    pantalaimonUrl?: string;
    userDeviceId?: string;
  };

  private sessionManager: MatrixSessionManager;
  private client: sdk.MatrixClient | null = null;
  private deviceId: string | null = null;
  private running = false;
  private initialSyncDone = false;
  private pendingImages: Map<string, { eventId: string; roomId: string; imageData: Buffer; format: string; timestamp: number }> = new Map();
  private ourAudioEvents: Set<string> = new Set();
  private verificationHandler: MatrixVerificationHandler | null = null;
  private pendingEncryptedEvents: Map<string, sdk.MatrixEvent> = new Map();
  private storage: MatrixStorage;

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;

  constructor(config: MatrixAdapterConfig) {
    if (!config.homeserverUrl) throw new Error("homeserverUrl is required");
    if (!config.userId) throw new Error("userId is required");
    if (!config.password && !config.accessToken) {
      throw new Error("Either password or accessToken is required");
    }

    const storeDir = config.storeDir || "./data/matrix";
    this.config = {
      homeserverUrl: config.homeserverUrl,
      userId: config.userId,
      accessToken: config.accessToken ?? undefined,
      password: config.password ?? undefined,
      deviceId: config.deviceId ?? undefined,
      recoveryKey: config.recoveryKey ?? undefined,
      dmPolicy: config.dmPolicy || "pairing",
      allowedUsers: config.allowedUsers || [],
      selfChatMode: config.selfChatMode !== false,
      enableEncryption: config.enableEncryption !== false,
      storeDir,
      sessionFile: config.sessionFile || `${storeDir}/session.json`,
      transcriptionEnabled: config.transcriptionEnabled !== false,
      sttUrl: config.sttUrl ?? undefined,
      ttsUrl: config.ttsUrl ?? undefined,
      ttsVoice: config.ttsVoice || DEFAULTS.TTS_VOICE,
      enableAudioResponse: config.enableAudioResponse || false,
      audioRoomFilter: config.audioRoomFilter || DEFAULTS.AUDIO_ROOM_FILTER,
      imageMaxSize: config.imageMaxSize || DEFAULTS.IMAGE_MAX_SIZE,
      enableReactions: config.enableReactions !== false,
      autoJoinRooms: config.autoJoinRooms !== false,
      messagePrefix: config.messagePrefix ?? undefined,
      pantalaimonUrl: config.pantalaimonUrl ?? undefined,
      userDeviceId: config.userDeviceId ?? undefined,
    };

    if (this.config.pantalaimonUrl) {
      console.log(`[Matrix] Using Pantalaimon proxy at ${this.config.pantalaimonUrl}`);
      console.log(`[Matrix] E2EE will be handled by Pantalaimon (built-in crypto disabled)`);
    }

    this.sessionManager = new MatrixSessionManager({ sessionFile: this.config.sessionFile });
    this.storage = new MatrixStorage({ dataDir: storeDir });

    console.log(`[Matrix] Adapter initialized for ${config.userId}`);
  }

  async start(): Promise<void> {
    if (this.running) return;

    console.log("[Matrix] Starting adapter...");
    await this.storage.init();
    await this.initClient();
    this.setupEventHandlers();
    await this.startSync();

    this.running = true;
    console.log("[Matrix] Adapter started successfully");
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.client) {
      await this.client.stopClient();
      this.client = null;
    }

    this.running = false;
    console.log("[Matrix] Adapter stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.client) throw new Error("Matrix client not initialized");

    const { chatId, text } = msg;
    const { plain, html } = formatMatrixHTML(text);

    const content = {
      msgtype: MsgType.Text,
      body: this.config.messagePrefix ? `${this.config.messagePrefix}\n\n${plain}` : plain,
      format: "org.matrix.custom.html",
      formatted_body: this.config.messagePrefix ? `${this.config.messagePrefix}<br><br>${html}` : html,
    } as RoomMessageEventContent;

    const response = await this.client.sendMessage(chatId, content);
    return { messageId: response.event_id };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.client) throw new Error("Matrix client not initialized");

    const { plain, html } = formatMatrixHTML(text);

    const editContent = {
      msgtype: MsgType.Text,
      body: `* ${plain}`,
      format: "org.matrix.custom.html",
      formatted_body: html,
      "m.new_content": {
        msgtype: MsgType.Text,
        body: plain,
        format: "org.matrix.custom.html",
        formatted_body: html,
      },
      "m.relates_to": {
        rel_type: sdk.RelationType.Replace,
        event_id: messageId,
      },
    } as RoomMessageEventContent;

    await this.client.sendMessage(chatId, editContent);
  }

  supportsEditing(): boolean {
    return true; // Matrix supports streaming via m.replace edits — Element renders them as live updates
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendTyping(chatId, true, 30000);
    } catch (err) {
      console.warn("[Matrix] Failed to send typing indicator:", err);
    }
  }

  private async initClient(): Promise<void> {
    console.log("[Matrix] Initializing client...");

    // Determine which homeserver to connect to
    const usePantalaimon = !!this.config.pantalaimonUrl;
    const baseUrl = usePantalaimon ? this.config.pantalaimonUrl! : this.config.homeserverUrl;

    if (usePantalaimon) {
      console.log(`[Matrix] Connecting to Pantalaimon proxy at ${baseUrl}`);
    }

    const session = this.sessionManager.loadSession();

    if (session?.accessToken) {
      this.client = sdk.createClient({
        baseUrl: baseUrl,
        userId: session.userId,
        accessToken: session.accessToken,
        deviceId: session.deviceId ?? this.config.deviceId ?? undefined,
        // Only use crypto callbacks when NOT using Pantalaimon
        cryptoCallbacks: (!usePantalaimon && this.config.recoveryKey) ? getCryptoCallbacks(this.config.recoveryKey) : undefined,
      });
      this.deviceId = session.deviceId || this.config.deviceId || null;
      console.log(`[Matrix] Session restored (device: ${this.deviceId})`);
    } else if (this.config.password) {
      const tempClient = sdk.createClient({ baseUrl: baseUrl });
      const response = await tempClient.loginWithPassword(this.config.userId, this.config.password);

      this.client = sdk.createClient({
        baseUrl: baseUrl,
        userId: response.user_id,
        accessToken: response.access_token,
        deviceId: response.device_id ?? this.config.deviceId ?? undefined,
        // Only use crypto callbacks when NOT using Pantalaimon
        cryptoCallbacks: (!usePantalaimon && this.config.recoveryKey) ? getCryptoCallbacks(this.config.recoveryKey) : undefined,
      });

      this.deviceId = response.device_id || this.config.deviceId || null;
      console.log(`[Matrix] Logged in as ${response.user_id}`);

      this.sessionManager.saveSession({
        userId: response.user_id,
        deviceId: this.deviceId!,
        accessToken: response.access_token,
        homeserver: this.config.homeserverUrl,
        timestamp: new Date().toISOString(),
      });
    } else {
      throw new Error("Either accessToken or password is required");
    }

    // Only initialize built-in E2EE when NOT using Pantalaimon
    // Pantalaimon handles all E2EE encryption/decryption
    if (this.config.enableEncryption && !usePantalaimon) {
      await initE2EE(this.client, {
        enableEncryption: true,
        recoveryKey: this.config.recoveryKey,
        storeDir: this.config.storeDir,
        password: this.config.password,
        userId: this.config.userId,
      });

      // Register callback for when room keys are updated (received from other devices)
      const crypto = this.client.getCrypto();
      if (crypto && (crypto as any).registerRoomKeyUpdatedCallback) {
        (crypto as any).registerRoomKeyUpdatedCallback(() => {
          console.log("[Matrix] Room keys updated, retrying pending decryptions...");
          this.retryPendingDecryptions();
        });
      }
    } else if (usePantalaimon) {
      console.log("[Matrix] E2EE handled by Pantalaimon proxy (built-in crypto disabled)");
    }
  }

  /**
   * Retry decrypting pending encrypted events after receiving new keys
   */
  private async retryPendingDecryptions(): Promise<void> {
    if (!this.client || this.pendingEncryptedEvents.size === 0) return;

    console.log(`[Matrix] Retrying ${this.pendingEncryptedEvents.size} pending decryptions...`);
    const eventsToRetry = new Map(this.pendingEncryptedEvents);
    this.pendingEncryptedEvents.clear();

    for (const [eventId, event] of Array.from(eventsToRetry.entries())) {
      try {
        // Try to get decrypted content now
        const clearContent = event.getClearContent();
        if (clearContent) {
          console.log(`[Matrix] Successfully decrypted event ${eventId} after key arrival`);
          // Process as room message
          const room = this.client.getRoom(event.getRoomId()!);
          if (room) {
            await this.handleMessageEvent(event, room);
          }
        } else {
          // Still can't decrypt, put back in queue
          this.pendingEncryptedEvents.set(eventId, event);
        }
      } catch (err) {
        console.warn(`[Matrix] Failed to retry decryption for ${eventId}:`, err);
        // Put back in queue for next retry
        this.pendingEncryptedEvents.set(eventId, event);
      }
    }

    // Clean up old events (keep for 5 minutes max)
    const now = Date.now();
    const maxAge = 5 * 60 * 1000;
    for (const [eventId, event] of Array.from(this.pendingEncryptedEvents.entries())) {
      const eventTime = event.getTs();
      if (now - eventTime > maxAge) {
        this.pendingEncryptedEvents.delete(eventId);
        console.log(`[Matrix] Dropped old pending event ${eventId}`);
      }
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on(RoomMemberEvent.Membership, (event, member) => {
      if (!this.initialSyncDone) return;
      if (this.config.autoJoinRooms) {
        handleMembershipEvent({
          client: this.client!,
          event,
          member,
          dmPolicy: this.config.dmPolicy,
          allowedUsers: this.config.allowedUsers,
          autoAccept: true,
        }).catch(console.error);
      }
    });

    this.client.on(RoomEvent.Timeline, async (event, room, toStartOfTimeline) => {
      let eventType = event.getType();

      // Always process encrypted events to request keys if needed
      // Other events can be skipped during initial sync
      if (eventType !== 'm.room.encrypted' && (toStartOfTimeline || !this.initialSyncDone)) {
        console.log(`[MatrixDebug] Timeline event skipped: toStartOfTimeline=${toStartOfTimeline}, initialSyncDone=${this.initialSyncDone}`);
        return;
      }
      if (event.getSender() === this.client?.getUserId()) {
        console.log(`[MatrixDebug] Timeline event skipped: own message`);
        return;
      }
      if (!room) {
        console.log(`[MatrixDebug] Timeline event skipped: no room`);
        return;
      }

      console.log(`[MatrixDebug] Timeline event: type=${eventType}, sender=${event.getSender()}, room=${room.roomId}`);

      // Handle encrypted events - check if SDK has decrypted them
      if (eventType === 'm.room.encrypted') {
        console.log(`[MatrixDebug] Encrypted event received, checking for decrypted content...`);

        // Try to get decrypted content
        const clearContent = event.getClearContent();
        if (clearContent) {
          // SDK has decrypted this event - get the actual event type from the decrypted content
          // We need to check if there's a msgtype to determine what kind of message this is
          const msgtype = (clearContent as any).msgtype;
          console.log(`[MatrixDebug] Event decrypted by SDK, msgtype=${msgtype}`);

          // Treat decrypted events as room messages for processing
          // The actual content will be extracted in handleMessageEvent
          eventType = sdk.EventType.RoomMessage;
        } else {
          console.log(`[MatrixDebug] SDK couldn't decrypt event yet, waiting for keys...`);
          // Listen for when this specific event gets decrypted
          event.once("Event.decrypted" as any, async (decryptedEvent: typeof event) => {
            const clearContent = decryptedEvent.getClearContent();
            if (clearContent) {
              console.log(`[Matrix] Event ${decryptedEvent.getId()} decrypted after key arrival!`);
              // Process the now-decrypted event
              const decryptedRoom = this.client?.getRoom(decryptedEvent.getRoomId()!);
              if (decryptedRoom) {
                await this.handleMessageEvent(decryptedEvent, decryptedRoom);
              }
            }
          });
          // Request keys from other devices
          this.requestRoomKey(event).catch((err) => {
            console.warn("[Matrix] Failed to request room key:", err);
          });
          return; // Skip immediate processing - will handle when Event.decrypted fires
        }
      }

      try {
        // Handle verification requests that come through room timeline
        if (eventType === 'm.key.verification.request') {
          console.log(`[MatrixDebug] Verification request received in room timeline from ${event.getSender()}`);
          return; // Don't process as regular message - verification handler will handle it
        }

        // Handle room key events - these are crucial for decryption
        if (eventType === 'm.room_key' || eventType === 'm.forwarded_room_key') {
          const keyContent = event.getContent();
          console.log(`[MatrixDebug] Room key received from ${event.getSender()}:`);
          console.log(`[MatrixDebug]   Room: ${keyContent.room_id}`);
          console.log(`[MatrixDebug]   Session: ${keyContent.session_id}`);
          console.log(`[MatrixDebug]   Algorithm: ${keyContent.algorithm}`);
          console.log(`[MatrixDebug]   Sender Key: ${keyContent.sender_key?.substring(0, 16)}...`);
          // Retry any pending decryptions now that we have new keys
          this.retryPendingDecryptions();
          return;
        }

        switch (eventType) {
          case sdk.EventType.RoomMessage:
            await this.handleMessageEvent(event, room);
            break;
          case sdk.EventType.Reaction:
            await handleReactionEvent({
              client: this.client!,
              event,
              ourUserId: this.client!.getUserId()!,
              storage: this.storage,
              sendMessage: async (roomId, text) => {
                await this.sendMessage({ chatId: roomId, text });
              },
              regenerateTTS: async (text, roomId) => {
                await this.regenerateTTS(text, roomId);
              },
              forwardToLetta: async (text, roomId, sender) => {
                if (this.onMessage) {
                  await this.onMessage({
                    channel: 'matrix',
                    chatId: roomId,
                    userId: sender,
                    text,
                    timestamp: new Date(),
                  });
                }
              },
            });
            break;
        }
      } catch (err) {
        console.error("[Matrix] Error handling event:", err);
      }
    });

    this.client.on(ClientEvent.Sync, (state) => {
      console.log(`[Matrix] Sync state: ${state}`);
      if (state === "PREPARED" || state === "SYNCING") {
        if (!this.initialSyncDone) {
          this.initialSyncDone = true;
          console.log("[Matrix] Initial sync complete");
          // Run post-sync setup in background (non-blocking)
          this.runPostSyncSetup().catch((err) => {
            console.error("[Matrix] Post-sync setup failed:", err);
          });
        }
      }
    });
  }

  private setupVerificationHandler(): void {
    if (!this.client) return;

    this.verificationHandler = new MatrixVerificationHandler(this.client, {
      onShowSas: (emojis) => {
        console.log(`[Matrix] *** EMOJI VERIFICATION ***`);
        console.log(`[Matrix] ${emojis.join(" | ")}`);
      },
      onComplete: () => {
        console.log(`[Matrix] *** VERIFICATION COMPLETE! ***`);
      },
      onCancel: (reason) => {
        console.log(`[Matrix] *** VERIFICATION CANCELLED: ${reason} ***`);
      },
      onError: (err) => {
        console.error(`[Matrix] Verification error:`, err);
      },
    });

    // CRITICAL: Setup event handlers for verification
    // This MUST be called before client.startClient()
    this.verificationHandler.setupEventHandlers();
  }

  /**
   * Auto-trust all devices for this user (similar to Python's TrustState.UNVERIFIED)
   * This allows the bot to decrypt messages without interactive verification
   */
  private async runPostSyncSetup(): Promise<void> {
    console.log("[Matrix] Running post-sync setup...");
    try {
      // Auto-trust all devices for this user
      await this.autoTrustDevices();
    } catch (err) {
      console.error("[Matrix] autoTrustDevices failed:", err);
    }
    try {
      // Restore keys from backup
      await this.restoreKeysFromBackup();
    } catch (err) {
      console.error("[Matrix] restoreKeysFromBackup failed:", err);
    }
    try {
      // Import room keys from file if available
      await this.importRoomKeysFromFile();
    } catch (err) {
      console.error("[Matrix] importRoomKeysFromFile failed:", err);
    }
    try {
      // Initiate proactive verification
      await this.initiateProactiveVerification();
    } catch (err) {
      console.error("[Matrix] initiateProactiveVerification failed:", err);
    }
    console.log("[Matrix] Post-sync setup complete");
  }

  private async autoTrustDevices(): Promise<void> {
    if (!this.client) return;
    const crypto = this.client.getCrypto();
    if (!crypto) return;

    const userId = this.client.getUserId();
    if (!userId) return;

    try {
      console.log("[Matrix] Auto-trusting devices for", userId);

      // Get all devices for this user
      const devices = await crypto.getUserDeviceInfo([userId]);
      const userDevices = devices.get(userId);

      if (!userDevices) {
        console.log("[Matrix] No devices found for user");
        return;
      }

      for (const [deviceId, deviceInfo] of Array.from(userDevices.entries())) {
        if (deviceId === this.client.getDeviceId()) {
          // Skip our own device
          continue;
        }

        // Check if already verified
        const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
        if (!status?.isVerified()) {
          console.log(`[Matrix] Marking device ${deviceId} as verified`);
          await crypto.setDeviceVerified(userId, deviceId, true);
        }
      }

      console.log("[Matrix] Device trust setup complete");
    } catch (err) {
      console.error("[Matrix] Failed to auto-trust devices:", err);
    }
  }

  /**
   * Import room keys from exported file
   * This allows decryption of messages from Element export
   */
  private async importRoomKeysFromFile(): Promise<void> {
    if (!this.client) return;

    const fs = await import('fs');
    const path = await import('path');

    // Check for pre-decrypted keys first (from import-casey-keys.ts)
    const storeDir = path.resolve(this.config.storeDir || './data/matrix');
    const decryptedKeysFile = path.join(storeDir, 'imported-keys.json');

    if (fs.existsSync(decryptedKeysFile)) {
      console.log("[Matrix] Found pre-decrypted keys at", decryptedKeysFile);
      try {
        const keysData = fs.readFileSync(decryptedKeysFile, 'utf8');
        const keys = JSON.parse(keysData);
        console.log(`[Matrix] Importing ${keys.length} pre-decrypted room keys...`);

        const crypto = this.client.getCrypto();
        if (crypto) {
          await crypto.importRoomKeys(keys);
          console.log("[Matrix] ✓ Room keys imported successfully!");
          // Rename file to indicate it's been imported
          fs.renameSync(decryptedKeysFile, decryptedKeysFile + '.imported');
          return;
        }
      } catch (err) {
        console.warn("[Matrix] Failed to import pre-decrypted keys:", err);
      }
    }

    // Fallback to legacy key file location
    const keyFile = '/tmp/room_keys.txt';

    if (!fs.existsSync(keyFile)) {
      console.log("[Matrix] No room key file found");
      return;
    }

    console.log("[Matrix] Importing room keys from file...");
    try {
      // Read the key file (may be encrypted)
      const keyData = fs.readFileSync(keyFile);

      // Try to import directly first (may work if not encrypted)
      try {
        const keys = JSON.parse(keyData.toString());
        await this.client.importRoomKeys(keys);
        console.log("[Matrix] Room keys imported successfully (plaintext)");
        return;
      } catch {
        // File is encrypted, need to decrypt first
        console.log("[Matrix] Key file is encrypted, decrypting...");
      }

      // Decrypt using the recovery key
      if (!this.config.recoveryKey) {
        console.log("[Matrix] No recovery key available to decrypt key file");
        return;
      }

      // Use the SDK's decryptAndImport method
      const { decodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto/recoverykey.js");
      const decryptionKey = decodeRecoveryKey(this.config.recoveryKey);

      // Read as binary and decrypt
      const encryptedData = fs.readFileSync(keyFile);
      const decrypted = await this.decryptMegolmExport(encryptedData, decryptionKey);

      const keys = JSON.parse(decrypted);
      await this.client.importRoomKeys(keys);
      console.log("[Matrix] Room keys imported successfully (decrypted)");
    } catch (err) {
      console.warn("[Matrix] Failed to import room keys:", err);
    }
  }

  /**
   * Decrypt Megolm export file using recovery key
   */
  private async decryptMegolmExport(data: Buffer, key: Uint8Array): Promise<string> {
    // Element exports use a specific format:
    // 1. Base64 encoded data
    // 2. Encrypted with AES-GCM
    // 3. Key derived from recovery key

    // Extract base64 content
    const content = data.toString('utf8');
    const lines = content.trim().split('\n');
    const base64Data = lines.slice(1, -1).join('');  // Remove BEGIN/END markers

    // Decode base64
    const encrypted = Buffer.from(base64Data, 'base64');

    // For now, just return as-is and let the SDK handle it
    // The SDK's importRoomKeys may handle the decryption
    return encrypted.toString('utf8');
  }

  /**
   * Restore room keys from backup after sync completes
   * This is needed to decrypt historical messages
   */
  private async restoreKeysFromBackup(): Promise<void> {
    if (!this.client || !this.config.recoveryKey) return;

    const crypto = this.client.getCrypto();
    if (!crypto) return;

    console.log("[Matrix] Checking key backup after sync...");
    try {
      // Get backup info without requiring it to be trusted
      const { decodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto/recoverykey.js");
      const backupKey = decodeRecoveryKey(this.config.recoveryKey);

      // First, try to enable backup by storing the key
      try {
        await crypto.storeSessionBackupPrivateKey(backupKey);
        console.log("[Matrix] Backup key stored in session");
      } catch (e) {
        // Key might already be stored
      }

      // Check backup info
      try {
        const backupInfo = await crypto.checkKeyBackupAndEnable();
        if (backupInfo) {
          console.log("[Matrix] Key backup info retrieved, attempting restore...");
          try {
            const result = await (this.client as any).restoreKeyBackup(
              backupKey,
              undefined, // all rooms
              undefined, // all sessions
              backupInfo.backupInfo,
            );
            console.log(`[Matrix] Restored ${result.imported} keys from backup`);
            // Retry pending decryptions with newly restored keys
            if (result.imported > 0) {
              console.log("[Matrix] Retrying pending decryptions after backup restore...");
              await this.retryPendingDecryptions();
            }
          } catch (restoreErr: any) {
            console.warn("[Matrix] Failed to restore keys from backup:", restoreErr.message || restoreErr);
            console.log("[Matrix] Will try to get keys from other devices via key sharing");
          }
        } else {
          console.log("[Matrix] No trusted key backup available - will rely on key sharing from verified devices");
        }
      } catch (backupCheckErr: any) {
        console.warn("[Matrix] Key backup check failed (this is expected with a new device):", backupCheckErr.message || backupCheckErr);
      }

      // CRITICAL: Wait a bit for sync to complete before proceeding
      // This allows verification to work properly
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err: any) {
      console.warn("[Matrix] Key backup check failed:", err?.message || err);
    }
  }

  /**
   * Request room key from other devices when decryption fails
   */
  private async requestRoomKey(event: sdk.MatrixEvent): Promise<void> {
    if (!this.client) return;

    const content = event.getContent();
    const sender = event.getSender();
    const roomId = event.getRoomId();

    if (!content?.sender_key || !content?.session_id || !roomId) {
      console.log(`[MatrixDebug] Cannot request key: missing sender_key, session_id, or roomId`);
      return;
    }

    console.log(`[Matrix] Requesting room key:`);
    console.log(`[Matrix]   Room: ${roomId}`);
    console.log(`[Matrix]   Session: ${content.session_id}`);
    console.log(`[Matrix]   Sender Key: ${content.sender_key?.substring(0, 16)}...`);
    console.log(`[Matrix]   Algorithm: ${content.algorithm}`);
    console.log(`[Matrix]   From user: ${sender}`);

    try {
      // Use the legacy crypto's requestRoomKey via the client
      // This sends m.room_key_request to other devices
      await (this.client as any).requestRoomKey({
        room_id: roomId,
        sender_key: content.sender_key,
        session_id: content.session_id,
        algorithm: content.algorithm,
      }, [
        { userId: sender!, deviceId: '*' } // Request from all devices of the sender
      ]);
      console.log(`[Matrix] Room key request sent successfully`);
    } catch (err) {
      // requestRoomKey might not exist in rust crypto, that's ok
      console.log(`[Matrix] Room key request not supported or failed (this is expected with rust crypto)`);
    }
  }

  /**
   * Request verification with a specific device
   * Useful for proactive verification
   */
  async requestDeviceVerification(userId: string, deviceId: string): Promise<VerificationRequest> {
    if (!this.verificationHandler) {
      throw new Error("Verification handler not initialized");
    }

    console.log(`[Matrix] Requesting verification with ${userId}:${deviceId}`);
    return this.verificationHandler.requestVerification(userId, deviceId);
  }

  /**
   * Get current verification requests for a user
   */
  getVerificationRequests(userId: string): VerificationRequest[] {
    if (!this.verificationHandler) return [];
    return this.verificationHandler.getVerificationRequests(userId);
  }

  /**
   * Proactively initiate verification with user devices
   * This triggers Element to show the emoji verification UI
   */
  private async initiateProactiveVerification(): Promise<void> {
    if (!this.client || !this.verificationHandler) return;
    const crypto = this.client.getCrypto();
    if (!crypto) return;

    const userId = this.client.getUserId();
    if (!userId) return;

    const ownDeviceId = this.client.getDeviceId();

    try {
      console.log(`[Matrix] *** INITIATING PROACTIVE VERIFICATION ***`);

      // If userDeviceId is configured, send verification request directly to it
      if (this.config.userDeviceId && this.config.userDeviceId.trim()) {
        const targetDeviceId = this.config.userDeviceId.trim();

        if (targetDeviceId === ownDeviceId) {
          console.log(`[Matrix] userDeviceId (${targetDeviceId}) is the same as bot's device ID - skipping`);
          return;
        }

        console.log(`[Matrix] Using configured userDeviceId: ${targetDeviceId}`);

        try {
          console.log(`[Matrix] *** REQUESTING VERIFICATION with user device ${targetDeviceId} ***`);
          await this.requestDeviceVerification(userId, targetDeviceId);
          console.log(`[Matrix] ✓ Verification request sent to ${targetDeviceId}`);
          console.log(`[Matrix] *** Check Element - the emoji verification UI should now appear! ***`);
          return; // Done - targeted device verified successfully
        } catch (err) {
          console.error(`[Matrix] Failed to request verification with configured device ${targetDeviceId}:`, err);
          console.log(`[Matrix] Falling back to automatic device discovery...`);
        }
        // Fall through to auto-discovery if direct request fails
      }

      // The device list query is async and may not be complete yet
      // Retry a few times with delays to get the full device list
      let userDevices: Map<string, sdk.Device> | undefined;
      let retryCount = 0;
      const maxRetries = 5;

      while (retryCount < maxRetries) {
        console.log(`[Matrix] Fetching device list (attempt ${retryCount + 1}/${maxRetries})...`);

        const devices = await crypto.getUserDeviceInfo([userId]);
        userDevices = devices.get(userId);

        if (!userDevices || userDevices.size === 0) {
          console.log(`[Matrix] No devices found for user ${userId}, retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          retryCount++;
        } else {
          console.log(`[Matrix] Found ${userDevices.size} device(s) for user ${userId}`);
          // Log all device IDs
          for (const [deviceId] of Array.from(userDevices.entries())) {
            console.log(`[Matrix]   - Device: ${deviceId}`);
          }
          break;
        }
      }

      if (!userDevices || userDevices.size === 0) {
        console.log(`[Matrix] No devices found for user ${userId} after ${maxRetries} attempts`);
        return;
      }

      let initiatedCount = 0;

      // Request verification with each of the user's other devices (not the bot's device)
      for (const [deviceId, deviceInfo] of Array.from(userDevices.entries())) {
        // Skip our own device
        if (deviceId === ownDeviceId) {
          console.log(`[Matrix] Skipping own device ${deviceId}`);
          continue;
        }

        console.log(`[Matrix] Checking device ${deviceId} for verification...`);
        console.log(`[Matrix] Device info:`, JSON.stringify(deviceInfo)); // Debug logging

        // Check if this device is already verified from our perspective
        const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
        console.log(`[Matrix] Device ${deviceId} verification status:`, {
          isVerified: status?.isVerified(),
          localVerified: status?.localVerified,
          crossSigningVerified: status?.crossSigningVerified,
        });

        if (status && status.isVerified()) {
          console.log(`[Matrix] Device ${deviceId} is already verified`);
          continue;
        }

        console.log(`[Matrix] *** REQUESTING VERIFICATION with user device ${deviceId} ***`);
        try {
          await this.requestDeviceVerification(userId, deviceId);
          initiatedCount++;
          console.log(`[Matrix] ✓ Verification request sent to ${deviceId}`);
        } catch (err) {
          console.warn(`[Matrix] Failed to request verification with ${deviceId}:`, err);
        }
      }

      if (initiatedCount > 0) {
        console.log(`[Matrix] ✓ Successfully initiated ${initiatedCount} verification request(s)`);
        console.log(`[Matrix] *** Check Element - the emoji verification UI should now appear! ***`);
      } else {
        console.log(`[Matrix] No new verification requests initiated (all devices may be verified)`);
      }
    } catch (err) {
      console.error(`[Matrix] Failed to initiate proactive verification:`, err);
    }
  }

  private async handleMessageEvent(event: sdk.MatrixEvent, room: sdk.Room): Promise<void> {
    // For encrypted events, use clear content if available
    const content = event.getClearContent() || event.getContent();
    const msgtype = content?.msgtype;
    const ourUserId = this.client!.getUserId();
    console.log(`[MatrixDebug] handleMessageEvent: msgtype=${msgtype}, ourUserId=${ourUserId}`);
    if (!ourUserId) return;

    if (msgtype === "m.text" || msgtype === "m.notice") {
      console.log(`[MatrixDebug] Processing text message from ${event.getSender()}: ${content.body?.substring(0, 50)}`);
      const result = await handleTextMessage({
        client: this.client!,
        room,
        event,
        ourUserId,
        config: {
          selfChatMode: this.config.selfChatMode,
          dmPolicy: this.config.dmPolicy,
          allowedUsers: this.config.allowedUsers,
        },
        sendMessage: async (roomId, text) => {
          await this.sendMessage({ chatId: roomId, text });
        },
        onCommand: this.onCommand,
      });

      if (result) {
        console.log(`[MatrixDebug] Sending to onMessage: chatId=${result.chatId}, text=${result.text?.substring(0, 50)}, onMessage defined=${!!this.onMessage}`);
        if (this.onMessage) {
          await this.onMessage(result);
        } else {
          console.error(`[MatrixDebug] onMessage is not defined!`);
        }
      } else {
        console.log(`[MatrixDebug] handleTextMessage returned null - message not sent to bot`);
      }
    } else if (msgtype === "m.audio") {
      await this.handleAudioMessage(event, room);
    } else if (msgtype === "m.image") {
      await this.handleImageMessage(event, room);
    }
  }

  private async handleAudioMessage(event: sdk.MatrixEvent, room: sdk.Room): Promise<void> {
    if (!this.client) return;

    const ourUserId = this.client.getUserId();
    if (!ourUserId) return;

    const result = await handleAudioMessage({
      client: this.client,
      room,
      event,
      ourUserId,
      transcriptionEnabled: this.config.transcriptionEnabled,
      sttUrl: this.config.sttUrl,
      sendTyping: async (roomId, typing) => {
        await this.client!.sendTyping(roomId, typing, 60000);
      },
      sendMessage: async (roomId, text) => {
        await this.sendMessage({ chatId: roomId, text });
      },
    });

    if (result) {
      await this.onMessage?.(result);
    }
  }

  private async handleImageMessage(event: sdk.MatrixEvent, room: sdk.Room): Promise<void> {
    if (!this.client) return;

    const ourUserId = this.client.getUserId();
    if (!ourUserId) return;

    await handleImageMessage({
      client: this.client,
      room,
      event,
      ourUserId,
      imageMaxSize: this.config.imageMaxSize,
      sendTyping: async (roomId, typing) => {
        await this.client!.sendTyping(roomId, typing, 30000);
      },
      sendMessage: async (roomId, text) => {
        await this.sendMessage({ chatId: roomId, text });
      },
      addReaction: async (roomId, eventId, emoji) => {
        const reactionContent = {
          "m.relates_to": {
            rel_type: sdk.RelationType.Annotation as string,
            event_id: eventId,
            key: emoji,
          },
        } as ReactionEventContent;
        await this.client!.sendEvent(roomId, sdk.EventType.Reaction, reactionContent);
      },
      storePendingImage: async (eventId, roomId, imageData, format) => {
        this.pendingImages.set(eventId, {
          eventId,
          roomId,
          imageData,
          format,
          timestamp: Date.now(),
        });
      },
    });
  }

  /**
   * Upload and send audio message to room
   */
  async uploadAndSendAudio(roomId: string, audioData: Buffer): Promise<string | null> {
    if (!this.client) return null;

    try {
      // Convert Buffer to Uint8Array for upload
      const uint8Array = new Uint8Array(audioData.buffer, audioData.byteOffset, audioData.byteLength);
      const blob = new Blob([uint8Array as unknown as BlobPart], { type: "audio/mpeg" });

      const uploadResponse = await this.client.uploadContent(blob, {
        name: "response.mp3",
        type: "audio/mpeg",
      });
      const mxcUrl = uploadResponse.content_uri;

      // Extract bot name from userId (@username:server -> username)
      const botName = this.config.userId.split(":")[0].slice(1) || "Bot";
      const voiceLabel = `${botName}'s voice`;

      const content = {
        msgtype: MsgType.Audio,
        body: voiceLabel,
        url: mxcUrl,
        info: {
          mimetype: "audio/mpeg",
          size: audioData.length,
        },
      } as RoomMessageEventContent;

      const response = await this.client.sendMessage(roomId, content);
      const eventId = response.event_id;

      this.ourAudioEvents.add(eventId);
      console.log(`[Matrix] Audio sent: ${eventId}...`);

      // Add 🎤 reaction for TTS regeneration
      const reactionContent = {
        "m.relates_to": {
          rel_type: sdk.RelationType.Annotation as string,
          event_id: eventId,
          key: "🎤",
        },
      } as ReactionEventContent;
      await this.client.sendEvent(roomId, sdk.EventType.Reaction, reactionContent);

      return eventId;
    } catch (err) {
      console.error("[Matrix] Failed to send audio:", err);
      return null;
    }
  }

  /**
   * Regenerate TTS for a text message
   */
  async regenerateTTS(text: string, roomId: string): Promise<string | null> {
    if (!this.client || !this.config.ttsUrl) return null;

    try {
      const audioData = await synthesizeSpeech(text, {
        url: this.config.ttsUrl,
        voice: this.config.ttsVoice,
      });

      return await this.uploadAndSendAudio(roomId, audioData);
    } catch (err) {
      console.error("[Matrix] Failed to regenerate TTS:", err);
      return null;
    }
  }

  /**
   * Store audio message text for 🎤 reaction regeneration
   */
  storeAudioMessage(messageId: string, conversationId: string, roomId: string, text: string): void {
    this.storage.storeAudioMessage(messageId, conversationId, roomId, text);
  }

  /**
   * Send TTS audio for a text response
   */
  async sendAudio(chatId: string, text: string): Promise<void> {
    if (!this.config.ttsUrl) return;

    try {
      const audioData = await synthesizeSpeech(text, {
        url: this.config.ttsUrl,
        voice: this.config.ttsVoice,
      });

      const audioEventId = await this.uploadAndSendAudio(chatId, audioData);
      if (audioEventId) {
        // Store for 🎤 regeneration
        this.storage.storeAudioMessage(audioEventId, "default", chatId, text);
      }
    } catch (err) {
      console.error("[Matrix] TTS failed (non-fatal):", err);
    }
  }

  /**
   * Get and consume a pending image for a room
   */
  getPendingImage(chatId: string): { imageData: Buffer; format: string } | null {
    for (const [key, img] of this.pendingImages.entries()) {
      if (img.roomId === chatId) {
        this.pendingImages.delete(key);
        return { imageData: img.imageData, format: img.format };
      }
    }
    return null;
  }

  /**
   * Track a sent message for reaction feedback
   */
  onMessageSent(chatId: string, messageId: string, stepId?: string): void {
    this.storage.storeMessageMapping(messageId, "default", stepId, "@ani:wiuf.net", chatId);
  }

  /**
   * Add an emoji reaction to a message
   */
  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    const reactionContent = {
      "m.relates_to": {
        rel_type: sdk.RelationType.Annotation as string,
        event_id: messageId,
        key: emoji,
      },
    } as ReactionEventContent;
    await this.client.sendEvent(chatId, sdk.EventType.Reaction, reactionContent);
  }

  /**
   * Get the storage instance (for reaction handler)
   */
  getStorage(): MatrixStorage {
    return this.storage;
  }

  private async startSync(): Promise<void> {
    if (!this.client) return;

    console.log("[Matrix] Starting sync...");

    // CRITICAL: Set up verification handlers BEFORE startClient()
    // Verification events arrive during initial sync, so we must be ready
    this.setupVerificationHandler();

    this.client.startClient({ initialSyncLimit: 10 });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Initial sync timeout")), 30000);
      const checkSync = () => {
        if (this.initialSyncDone) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkSync, 100);
        }
      };
      checkSync();
    });
  }
}

export function createMatrixAdapter(config: MatrixAdapterConfig): MatrixAdapter {
  return new MatrixAdapter(config);
}
