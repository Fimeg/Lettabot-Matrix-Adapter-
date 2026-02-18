/**
 * LettaBot Core - Handles agent communication
 * 
 * Single agent, single conversation - chat continues across all channels.
 */

import { createSession, resumeSession, type Session } from '@letta-ai/letta-code-sdk';
import { mkdirSync } from 'node:fs';
import type { ChannelAdapter } from '../channels/types.js';
import type { BotConfig, InboundMessage, TriggerContext } from './types.js';
import { Store } from './store.js';
import { updateAgentName, sendMultimodalToConversation, compactAgent, type MultimodalImage } from '../tools/letta-api.js';
import { installSkillsToAgent } from '../skills/loader.js';
import { formatMessageEnvelope } from './formatter.js';
import { loadMemoryBlocks } from './memory.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

// TTS sanitization is handled by cleanTextForTTS() in the Matrix adapter's tts.ts

export class LettaBot {
  private store: Store;
  private config: BotConfig;
  private channels: Map<string, ChannelAdapter> = new Map();
  private messageQueue: Array<{ msg: InboundMessage; adapter: ChannelAdapter }> = [];
  
  // Callback to trigger heartbeat (set by main.ts)
  public onTriggerHeartbeat?: () => Promise<void>;
  private processing = false;
  
  constructor(config: BotConfig) {
    this.config = config;
    
    // Ensure working directory exists
    mkdirSync(config.workingDir, { recursive: true });
    
    // Store in project root (same as main.ts reads for LETTA_AGENT_ID)
    this.store = new Store('lettabot-agent.json');
    
    console.log(`LettaBot initialized. Agent ID: ${this.store.agentId || '(new)'}`);
  }
  
  /**
   * Register a channel adapter
   */
  registerChannel(adapter: ChannelAdapter): void {
    adapter.onMessage = (msg) => this.handleMessage(msg, adapter);
    adapter.onCommand = (cmd) => this.handleCommand(cmd);
    this.channels.set(adapter.id, adapter);
    console.log(`Registered channel: ${adapter.name}`);
  }
  
  /**
   * Handle slash commands
   */
  private async handleCommand(command: string): Promise<string | null> {
    console.log(`[Command] Received: /${command}`);
    switch (command) {
      case 'status': {
        const info = this.store.getInfo();
        const lines = [
          `*Status*`,
          `Agent ID: \`${info.agentId || '(none)'}\``,
          `Created: ${info.createdAt || 'N/A'}`,
          `Last used: ${info.lastUsedAt || 'N/A'}`,
          `Channels: ${Array.from(this.channels.keys()).join(', ')}`,
        ];
        return lines.join('\n');
      }
      case 'heartbeat': {
        console.log('[Command] /heartbeat received');
        if (!this.onTriggerHeartbeat) {
          console.log('[Command] /heartbeat - no trigger callback configured');
          return '⚠️ Heartbeat service not configured';
        }
        console.log('[Command] /heartbeat - triggering heartbeat...');
        // Trigger heartbeat asynchronously
        this.onTriggerHeartbeat().catch(err => {
          console.error('[Heartbeat] Manual trigger failed:', err);
        });
        return '⏰ Heartbeat triggered (silent mode - check server logs)';
      }
      case 'compact': {
        console.log('[Command] compact received');
        const agentId = this.store.agentId;
        if (!agentId) return '⚠️ No agent ID — send a message first to initialize the session';
        const ok = await compactAgent(agentId);
        return ok ? '✅ Context compacted — Ani\'s memory summarized' : '❌ Compaction failed (check server logs)';
      }
      default:
        return null;
    }
  }
  
  /**
   * Start all registered channels
   */
  async start(): Promise<void> {
    const startPromises = Array.from(this.channels.entries()).map(async ([id, adapter]) => {
      try {
        console.log(`Starting channel: ${adapter.name}...`);
        await adapter.start();
        console.log(`Started channel: ${adapter.name}`);
      } catch (e) {
        console.error(`Failed to start channel ${id}:`, e);
      }
    });
    
    await Promise.all(startPromises);
  }
  
  /**
   * Stop all channels
   */
  async stop(): Promise<void> {
    for (const adapter of this.channels.values()) {
      try {
        await adapter.stop();
      } catch (e) {
        console.error(`Failed to stop channel ${adapter.id}:`, e);
      }
    }
  }
  
  /**
   * Queue incoming message for processing (prevents concurrent SDK sessions)
   */
  private async handleMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    console.log(`[${msg.channel}] Message from ${msg.userId}: ${msg.text}`);
    
    // Add to queue
    this.messageQueue.push({ msg, adapter });
    
    // Process queue if not already processing
    if (!this.processing) {
      this.processQueue();
    }
  }
  
  /**
   * Process messages one at a time
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.messageQueue.length === 0) return;
    
    this.processing = true;
    
    while (this.messageQueue.length > 0) {
      const { msg, adapter } = this.messageQueue.shift()!;
      try {
        await this.processMessage(msg, adapter);
      } catch (error) {
        console.error('[Queue] Error processing message:', error);
      }
    }
    
    this.processing = false;
  }
  
  /**
   * Process a single message
   */
  private async processMessage(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {

    // Track last message target for heartbeat delivery
    this.store.lastMessageTarget = {
      channel: msg.channel,
      chatId: msg.chatId,
      messageId: msg.messageId,
      updatedAt: new Date().toISOString(),
    };

    // Start typing indicator
    await adapter.sendTypingIndicator(msg.chatId);

    // Create or resume session
    let session: Session;
    // Base options for all sessions (model only included for new agents)
    // Note: canUseTool workaround for SDK v0.0.3 bug - can be removed after letta-ai/letta-code-sdk#10 is released

    const baseOptions = {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      cwd: this.config.workingDir,
      systemPrompt: SYSTEM_PROMPT,
      // Note: canUseTool workaround for SDK v0.0.3 bug - can be removed after letta-ai/letta-code-sdk#10 is released
      canUseTool: () => ({ allow: true }),
    };
    
    try {
      if (this.config.conversationId) {
        // Resume existing conversation - agent is derived automatically from conversationId
        console.log(`[Bot] Resuming conversation: ${this.config.conversationId}`);
        console.log(`[Bot] LETTA_BASE_URL=${process.env.LETTA_BASE_URL}`);
        session = createSession({ ...baseOptions, conversationId: this.config.conversationId });
      } else if (this.store.agentId) {
        process.env.LETTA_AGENT_ID = this.store.agentId;
        console.log(`[Bot] Resuming session for agent ${this.store.agentId}`);
        console.log(`[Bot] LETTA_BASE_URL=${process.env.LETTA_BASE_URL}`);
        console.log(`[Bot] LETTA_API_KEY=${process.env.LETTA_API_KEY ? '(set)' : '(not set)'}`);
        session = resumeSession(this.store.agentId, baseOptions);
      } else {
        console.log('[Bot] Creating new session');
        session = createSession({ ...baseOptions, model: this.config.model, memory: loadMemoryBlocks(this.config.agentName) });
      }
      
      const initTimeoutMs = 30000; // 30s timeout
      const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${initTimeoutMs}ms`));
          }, initTimeoutMs);
        });
        try {
          return await Promise.race([promise, timeoutPromise]);
        } finally {
          clearTimeout(timeoutId!);
        }
      };

      // Log diagnostic info for debugging connection issues
      console.log('[Bot] Initializing session...');
      console.log('[Bot] API key set:', !!process.env.LETTA_API_KEY);
      console.log('[Bot] Base URL:', process.env.LETTA_BASE_URL || 'https://api.letta.com (default)');
      console.log('[Bot] Node version:', process.version);

      const initInfo = await withTimeout(session.initialize(), 'Session initialize');
      console.log('[Bot] Session initialized, agent:', initInfo.agentId);

      // Check for pending images
      console.log('[Bot] Checking for pending images...');
      const pendingImage = adapter.getPendingImage?.(msg.chatId);
      if (pendingImage) {
        const sizeKB = Math.round(pendingImage.imageData.length / 1024);
        console.log(`[Bot] Pending image found: ${pendingImage.format}, ${sizeKB}KB - will send multimodal`);
      } else {
        console.log('[Bot] No pending images');
      }

      // Format the text message envelope
      console.log('[Bot] Formatting message envelope...');
      const formattedMessage = formatMessageEnvelope(msg);

      // Stream response
      let response = '';
      let lastUpdate = Date.now();
      let messageId: string | null = null;
      let sentAnyMessage = false;
      let lastStepId: string | undefined;

      // Tool visibility reaction tracking
      // Collected during the stream, flushed as reactions after the message is sent.
      // We deliberately do NOT send a placeholder mid-stream — awaiting Matrix HTTP
      // inside the for-await loop disrupts Letta SSE consumption.
      let hasReasoning = false;
      const toolEmojiQueue: string[] = [];
      const seenToolEmojis = new Set<string>();

      const getToolEmoji = (toolName: string): string => {
        const n = toolName.toLowerCase();
        if (n.includes('search') || n.includes('web') || n.includes('browse')) return '🔍';
        if (n.includes('read') || n.includes('get') || n.includes('fetch') || n.includes('retrieve') || n.includes('recall')) return '📖';
        if (n.includes('write') || n.includes('send') || n.includes('create') || n.includes('post') || n.includes('insert')) return '✍️';
        if (n.includes('memory') || n.includes('archival')) return '💾';
        if (n.includes('shell') || n.includes('bash') || n.includes('exec') || n.includes('run') || n.includes('code') || n.includes('terminal')) return '⚙️';
        if (n.includes('image') || n.includes('vision') || n.includes('photo')) return '📸';
        return '🔧';
      };

      // Helper to finalize and send current accumulated response
      const finalizeMessage = async () => {
        if (response.trim()) {
          try {
            if (messageId) {
              await adapter.editMessage(msg.chatId, messageId, response);
            } else {
              await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
            }
            sentAnyMessage = true;
          } catch {
            // Ignore send errors
          }
        }
        // Reset for next message bubble
        response = '';
        messageId = null;
        lastUpdate = Date.now();
      };

      // Keep typing indicator alive
      const typingInterval = setInterval(() => {
        adapter.sendTypingIndicator(msg.chatId).catch(() => {});
      }, 4000);

      // Choose stream source: multimodal REST API (image) or SDK session (text only)
      type StreamMsg = { type: string; content?: string; stepId?: string };
      let streamSource: AsyncIterable<StreamMsg>;

      if (pendingImage && this.config.conversationId) {
        // Multimodal path: bypass SDK, call Letta REST API directly with image
        const images: MultimodalImage[] = [{ data: pendingImage.imageData, format: pendingImage.format }];
        console.log(`[Bot] Using multimodal REST API path for image message`);
        streamSource = sendMultimodalToConversation(this.config.conversationId, formattedMessage, images);
      } else {
        // Text-only path: use SDK session
        console.log(`[Bot] Sending text message (${formattedMessage.length} chars) via SDK...`);
        try {
          await withTimeout(session.send(formattedMessage), 'Session send');
          console.log('[Bot] Message sent successfully');
        } catch (sendError) {
          console.error('[Bot] Error sending message:', sendError);
          throw sendError;
        }
        streamSource = session.stream() as AsyncIterable<StreamMsg>;
      }

      try {
        for await (const streamMsg of streamSource) {
          console.log(`[Bot] Stream message: type=${streamMsg.type}, content=${JSON.stringify(streamMsg.content)?.substring(0, 200)}`);

          // Track reasoning — reaction added post-send
          if (streamMsg.type === 'reasoning') {
            hasReasoning = true;
          }

          // Track tool calls — reactions added post-send
          if (streamMsg.type === 'tool_call') {
            const toolName = (streamMsg as any).toolName ?? '';
            const emoji = getToolEmoji(toolName);
            if (!seenToolEmojis.has(emoji) && seenToolEmojis.size < 6) {
              seenToolEmojis.add(emoji);
              toolEmojiQueue.push(emoji);
            }
          }

          // Handle assistant content only (skip reasoning)
          if (streamMsg.type === 'assistant') {
            response += streamMsg.content ?? '';
          }

          // Stream updates only for channels that support editing (Telegram, Slack)
          // Matrix: don't stream - accumulate everything and send at end
          if (streamMsg.type === 'assistant') {
            const canEdit = adapter.supportsEditing?.() ?? true;
            if (canEdit && Date.now() - lastUpdate > 500 && response.length > 0) {
              try {
                if (messageId) {
                  await adapter.editMessage(msg.chatId, messageId, response);
                } else {
                  const result = await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
                  messageId = result.messageId;
                }
              } catch {
                // Ignore edit errors
              }
              lastUpdate = Date.now();
            }
          }

          if (streamMsg.type === 'result') {
            // Capture step ID for message mapping
            lastStepId = (streamMsg as any).stepId || (streamMsg as any).step_id;
            // Save agent ID (SDK session path only)
            if (session.agentId && session.agentId !== this.store.agentId) {
              const isNewAgent = !this.store.agentId;
              const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
              this.store.setAgent(session.agentId, currentBaseUrl);
              console.log('Saved agent ID:', session.agentId, 'on server:', currentBaseUrl);
              if (isNewAgent) {
                if (this.config.agentName) {
                  updateAgentName(session.agentId, this.config.agentName).catch(() => {});
                }
                installSkillsToAgent(session.agentId);
              }
            }
            // Don't break - let the stream iterator naturally complete
          }
        }
      } finally {
        clearInterval(typingInterval);
      }
      
      // Send final response
      if (response.trim()) {
        try {
          if (messageId) {
            await adapter.editMessage(msg.chatId, messageId, response);
          } else {
            const result = await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
            messageId = result.messageId;
          }
          sentAnyMessage = true;
        } catch (sendError) {
          console.error('[Bot] Error sending response:', sendError);
          if (!messageId) {
            const result = await adapter.sendMessage({ chatId: msg.chatId, text: response, threadId: msg.threadId });
            messageId = result.messageId;
            sentAnyMessage = true;
          }
        }
      }
      
      // Only show "no response" if we never sent anything
      if (!sentAnyMessage) {
        await adapter.sendMessage({ chatId: msg.chatId, text: '(No response from agent)', threadId: msg.threadId });
      }

      // Post-response: Reactions + optional TTS audio (non-blocking)
      // TTS cleaning/sanitization is handled inside the adapter's synthesizeSpeech()
      if (sentAnyMessage && response.trim()) {
        if (messageId) {
          adapter.onMessageSent?.(msg.chatId, messageId, lastStepId);
          // Tool visibility reactions: 🧠 then per-tool emojis (collected during stream)
          if (hasReasoning) {
            adapter.addReaction?.(msg.chatId, messageId, '🧠').catch(() => {});
          }
          for (const emoji of toolEmojiQueue) {
            adapter.addReaction?.(msg.chatId, messageId, emoji).catch(() => {});
          }
          // Add 🎤 reaction to bot's TEXT message (tap to generate audio)
          adapter.addReaction?.(msg.chatId, messageId, "🎤").catch(() => {});
          // Store raw text — adapter's TTS layer will clean it at synthesis time
          (adapter as any).storeAudioMessage?.(messageId, "default", msg.chatId, response);
        }
        // Generate TTS audio only in response to voice input
        if (msg.isVoiceInput) {
          adapter.sendAudio?.(msg.chatId, response).catch((err) => {
            console.warn('[Bot] TTS failed (non-fatal):', err);
          });
        }
      }
      
    } catch (error) {
      console.error('[Bot] Error processing message:', error);
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        threadId: msg.threadId,
      });
    } finally {
      session!?.close();
    }
  }
  
  /**
   * Send a message to the agent (for cron jobs, webhooks, etc.)
   *
   * In silent mode (heartbeats, cron), the agent's text response is NOT auto-delivered.
   * The agent must use `lettabot-message` CLI via Bash to send messages explicitly.
   *
   * @param text - The prompt/message to send
   * @param context - Optional trigger context (for logging/tracking)
   * @returns The agent's response text
   */
  async sendToAgent(
    text: string,
    context?: TriggerContext,
    conversationIdOverride?: string | null
  ): Promise<string> {
    // Base options (model only for new agents)
    // Note: canUseTool workaround for SDK v0.0.3 bug - can be removed after letta-ai/letta-code-sdk#10 is released

    // Inject SILENT mode prefix when triggered from heartbeat/cron (outputMode=silent)
    // This tells the agent its text output goes nowhere - must use lettabot-message CLI
    let systemPrompt = SYSTEM_PROMPT;
    if (context?.outputMode === 'silent') {
      const silentModePrefix = `
╔════════════════════════════════════════════════════════════════╗
║  [SILENT MODE] - Your text output is NOT sent to anyone.       ║
║  To send a message, use: lettabot-message send --text "..."    ║
╚════════════════════════════════════════════════════════════════╝

`.trim();
      systemPrompt = silentModePrefix + '\n\n' + SYSTEM_PROMPT;
    }

    const baseOptions = {
      permissionMode: 'bypassPermissions' as const,
      allowedTools: this.config.allowedTools,
      cwd: this.config.workingDir,
      systemPrompt: systemPrompt,
      canUseTool: () => ({ allow: true }),
    };
    
    let session: Session;
    // Handle conversation selection:
    // - null explicitly passed: agent-level (heartbeat)
    // - undefined: use config.conversationId (normal user messages)
    // - string: use that specific conversation
    const convId = conversationIdOverride === undefined ? this.config.conversationId : conversationIdOverride;
    if (convId) {
      // Resume specific conversation
      session = createSession({ ...baseOptions, conversationId: convId });
    } else if (this.store.agentId) {
      // Agent-level (for heartbeat with null, or when no conversation configured)
      session = resumeSession(this.store.agentId, baseOptions);
    } else {
      session = createSession({ ...baseOptions, model: this.config.model, memory: loadMemoryBlocks(this.config.agentName) });
    }

    try {
      await session.send(text);
      
      let response = '';
      for await (const msg of session.stream()) {
        if (msg.type === 'assistant') {
          response += msg.content;
        }
        
        if (msg.type === 'result') {
          if (session.agentId && session.agentId !== this.store.agentId) {
            const currentBaseUrl = process.env.LETTA_BASE_URL || 'https://api.letta.com';
            this.store.setAgent(session.agentId, currentBaseUrl);
          }
          break;
        }
      }
      
      return response;
    } finally {
      session.close();
    }
  }
  
  /**
   * Get a channel adapter by name
   */
  getChannel(name: string): ChannelAdapter | undefined {
    return this.channels.get(name);
  }

  /**
   * Deliver a message to a specific channel
   */
  async deliverToChannel(channelId: string, chatId: string, text: string): Promise<void> {
    const adapter = this.channels.get(channelId);
    if (!adapter) {
      console.error(`Channel not found: ${channelId}`);
      return;
    }
    await adapter.sendMessage({ chatId, text });
  }
  
  /**
   * Get bot status
   */
  getStatus(): { agentId: string | null; channels: string[] } {
    return {
      agentId: this.store.agentId,
      channels: Array.from(this.channels.keys()),
    };
  }
  
  
  /**
   * Reset agent (clear memory)
   */
  reset(): void {
    this.store.reset();
    console.log('Agent reset');
  }
  
  /**
   * Get the last message target (for heartbeat delivery)
   */
  getLastMessageTarget(): { channel: string; chatId: string } | null {
    return this.store.lastMessageTarget || null;
  }
}
