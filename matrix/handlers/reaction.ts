/**
 * Reaction Handler
 *
 * Handles emoji reactions on bot messages:
 * - 👍/❤️/👏/🎉 → positive feedback to Letta
 * - 👎/😢/😔/❌ → negative feedback to Letta
 * - 🎤 → regenerate TTS audio
 */
import type * as sdk from "matrix-js-sdk";
import { POSITIVE_REACTIONS, NEGATIVE_REACTIONS, SPECIAL_REACTIONS } from "../types.js";
import type { MatrixStorage } from "../storage.js";
import { sendFeedback } from "../../../tools/letta-api.js";

interface ReactionHandlerContext {
  client: sdk.MatrixClient;
  event: sdk.MatrixEvent;
  ourUserId: string;
  storage: MatrixStorage;
  sendMessage: (roomId: string, text: string) => Promise<void>;
  regenerateTTS: (text: string, roomId: string) => Promise<void>;
  // Forward non-special reactions to the Letta agent so it can see and respond to them
  forwardToLetta?: (text: string, roomId: string, sender: string) => Promise<void>;
}

export async function handleReactionEvent(ctx: ReactionHandlerContext): Promise<void> {
  const { event, ourUserId, storage } = ctx;
  const content = event.getContent();
  const relatesTo = content["m.relates_to"];

  if (!relatesTo || relatesTo.rel_type !== "m.annotation") return;

  const reactionKey = relatesTo.key as string;
  const targetEventId = relatesTo.event_id as string;
  const sender = event.getSender();
  const roomId = event.getRoomId();

  // Ignore reactions from the bot itself
  if (sender === ourUserId) return;

  console.log(`[MatrixReaction] ${reactionKey} on ${targetEventId} from ${sender}`);

  // Handle 🎤 → regenerate TTS
  if (reactionKey === SPECIAL_REACTIONS.REGENERATE_AUDIO) {
    const originalText = storage.getOriginalTextForAudio(targetEventId);
    if (originalText && roomId) {
      console.log("[MatrixReaction] Regenerating TTS audio");
      await ctx.regenerateTTS(originalText, roomId);
    } else {
      console.log("[MatrixReaction] No original text found for audio event");
    }
    return;
  }

  // Handle feedback reactions (👍/👎 etc.)
  if (POSITIVE_REACTIONS.has(reactionKey) || NEGATIVE_REACTIONS.has(reactionKey)) {
    const isPositive = POSITIVE_REACTIONS.has(reactionKey);
    const score = isPositive ? 1.0 : -1.0;
    const stepIds = storage.getStepIdsForEvent(targetEventId);

    if (stepIds.length > 0) {
      const agentId = process.env.LETTA_AGENT_ID;
      if (agentId) {
        for (const stepId of stepIds) {
          const ok = await sendFeedback(agentId, stepId, score);
          console.log(`[MatrixReaction] Feedback ${isPositive ? "+" : "-"} for step ${stepId}: ${ok ? "sent" : "failed"}`);
        }
      }
    } else {
      console.log(`[MatrixReaction] No step IDs mapped for event ${targetEventId}`);
    }
    // Feedback reactions are still forwarded to Letta so the agent is aware
  }

  // Forward ALL reactions (including feedback ones) to Letta so the agent can see them
  // Format matches Python bridge: "🎭 {sender} reacted with: {emoji}"
  if (ctx.forwardToLetta && sender && roomId) {
    const reactionMsg = `🎭 ${sender} reacted with: ${reactionKey}`;
    console.log(`[MatrixReaction] Forwarding to Letta: ${reactionMsg}`);
    await ctx.forwardToLetta(reactionMsg, roomId, sender).catch((err) => {
      console.warn("[MatrixReaction] Failed to forward reaction to Letta:", err);
    });
  }
}

export function isSpecialReaction(reaction: string): boolean {
  return Object.values(SPECIAL_REACTIONS).includes(reaction as any);
}
