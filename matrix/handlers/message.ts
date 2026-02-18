/**
 * Message Handler
 *
 * Handles text messages and access control for Matrix.
 */

import type * as sdk from "matrix-js-sdk";
import type { InboundMessage } from "../../../core/types.js";
import type { DmPolicy } from "../../../pairing/types.js";
import { isUserAllowed, upsertPairingRequest } from "../../../pairing/store.js";
import { formatMatrixHTML } from "../html-formatter.js";

interface MessageHandlerContext {
	client: sdk.MatrixClient;
	room: sdk.Room;
	event: sdk.MatrixEvent;
	ourUserId: string;
	config: {
		selfChatMode: boolean;
		dmPolicy: DmPolicy;
		allowedUsers: string[];
	};
	sendMessage: (roomId: string, text: string) => Promise<void>;
	onCommand?: (command: string) => Promise<string | null>;
}

/**
 * Handle a text message event
 */
export async function handleTextMessage(
	ctx: MessageHandlerContext,
): Promise<InboundMessage | null> {
	const { client, room, event, ourUserId, config, sendMessage, onCommand } = ctx;

	const sender = event.getSender();
	const content = event.getContent();
	const body = content.body as string;

	if (!sender || !body) return null;

	// Skip our own messages
	if (sender === ourUserId) return null;

	// Check self-chat mode
	if (!config.selfChatMode && sender === ourUserId) {
		return null;
	}

	// Handle slash commands
	if (body.startsWith("/")) {
		const result = await handleCommand(body, onCommand);
		if (result) {
			await sendMessage(room.roomId, result);
			return null;
		}
	}

	// Check access control
	const access = await checkAccess(sender, config.dmPolicy, config.allowedUsers);

	if (access === "blocked") {
		await sendMessage(room.roomId, "Sorry, you're not authorized to use this bot.");
		return null;
	}

	if (access === "pairing") {
		const { code, created } = await upsertPairingRequest("matrix", sender, {
			firstName: extractDisplayName(sender),
		});

		if (!code) {
			await sendMessage(
				room.roomId,
				"Too many pending pairing requests. Please try again later.",
			);
			return null;
		}

		if (created) {
			const pairingMessage = `Hi! This bot requires pairing.

Your code: *${code}*

Ask the owner to run:
\`lettabot pairing approve matrix ${code}\`

This code expires in 1 hour.`;
			await sendMessage(room.roomId, pairingMessage);
		}
		return null;
	}

	// Build inbound message
	const isDm = isDirectMessage(room);
	const message: InboundMessage = {
		channel: "matrix",
		chatId: room.roomId,
		userId: sender,
		userName: extractDisplayName(sender),
		userHandle: sender,
		messageId: event.getId() || undefined,
		text: body,
		timestamp: new Date(event.getTs()),
		isGroup: !isDm,
		groupName: isDm ? undefined : room.name,
	};

	return message;
}

/**
 * Check access for a user
 */
export async function checkAccess(
	userId: string,
	policy: DmPolicy,
	allowedUsers: string[],
): Promise<"allowed" | "blocked" | "pairing"> {
	if (policy === "open") {
		return "allowed";
	}

	const allowed = await isUserAllowed("matrix", userId, allowedUsers);
	if (allowed) {
		return "allowed";
	}

	return policy === "allowlist" ? "blocked" : "pairing";
}

/**
 * Handle a slash command
 */
async function handleCommand(
	command: string,
	onCommand?: (command: string) => Promise<string | null>,
): Promise<string | null> {
	if (!onCommand) return null;

	// Strip the leading slash and process
	const cmd = command.slice(1).trim();
	return await onCommand(cmd);
}

/**
 * Check if a room is a direct message
 */
function isDirectMessage(room: sdk.Room): boolean {
	const members = room.getJoinedMembers();
	return members.length === 2;
}

/**
 * Extract display name from Matrix user ID
 */
function extractDisplayName(userId: string): string {
	// Extract from @user:server format
	const match = userId.match(/^@([^:]+):/);
	return match ? match[1] : userId;
}
