/**
 * ChatCommand - Chat commands for iRacing
 *
 * Handles chat operations using the iRacing broadcast API and Windows messaging
 */

import streamDeck from '@elgato/streamdeck';
import { BroadcastCommand } from './BroadcastCommand';
import { BroadcastMsg, ChatCommandMode } from './constants';
import { WM_CHAR, VK_RETURN } from '../windows-messaging';

/**
 * Chat commands
 */
export class ChatCommand extends BroadcastCommand {
	private static _instance: ChatCommand;

	private constructor() {
		super();
	}

	/**
	 * Get singleton instance
	 */
	static getInstance(): ChatCommand {
		if (!ChatCommand._instance) {
			ChatCommand._instance = new ChatCommand();
		}
		return ChatCommand._instance;
	}

	/**
	 * Send a chat broadcast message
	 */
	private sendChatBroadcast(command: ChatCommandMode, subCommand: number = 0): boolean {
		streamDeck.logger.debug(`[ChatCommand] sendBroadcast ${ChatCommandMode[command]}, ${subCommand}`);
		return this.sendBroadcast(BroadcastMsg.ChatCommand, command, subCommand);
	}

	/**
	 * Trigger a chat macro (1-15)
	 * @param macroNum Macro number (1-15, as shown in app.ini)
	 * @returns Success
	 */
	macro(macroNum: number): boolean {
		if (macroNum < 1 || macroNum > 15) {
			streamDeck.logger.warn(`[ChatCommand] Invalid macro number: ${macroNum}. Must be 1-15.`);
			return false;
		}

		streamDeck.logger.info(`[ChatCommand] Triggering chat macro ${macroNum}`);
		// API uses 0-based indexing, but app.ini uses 1-based numbering
		return this.sendChatBroadcast(ChatCommandMode.Macro, macroNum - 1);
	}

	/**
	 * Open the chat window
	 * @returns Success
	 */
	beginChat(): boolean {
		streamDeck.logger.debug('[ChatCommand] Opening chat window');
		return this.sendChatBroadcast(ChatCommandMode.BeginChat);
	}

	/**
	 * Reply to last private message
	 * @returns Success
	 */
	reply(): boolean {
		streamDeck.logger.debug('[ChatCommand] Opening reply to last private message');
		return this.sendChatBroadcast(ChatCommandMode.Reply);
	}

	/**
	 * Close the chat window
	 * @returns Success
	 */
	cancel(): boolean {
		streamDeck.logger.debug('[ChatCommand] Closing chat window');
		return this.sendChatBroadcast(ChatCommandMode.Cancel);
	}

	/**
	 * Send a custom chat message to iRacing
	 * Opens chat, types the message, and sends it
	 * @param hwnd Window handle to send the message to
	 * @param message The message to send
	 * @returns Success
	 */
	sendMessage(hwnd: any, message: string): boolean {
		if (!message || message.trim().length === 0) {
			streamDeck.logger.warn('[ChatCommand] Cannot send empty message');
			return false;
		}

		if (!hwnd) {
			streamDeck.logger.error('[ChatCommand] Invalid window handle');
			return false;
		}

		try {
			streamDeck.logger.info(`[ChatCommand] Sending chat message: "${message}"`);

			// Open chat window
			this.beginChat();

			streamDeck.logger.info('[ChatCommand] Chat window opened');

			// Wait for chat window to open, then type message
			setTimeout(() => {
				// Send each character using WM_CHAR
				for (const char of message) {
					this.windowsMessaging.sendMessage(hwnd, WM_CHAR, char.charCodeAt(0), 0);
				}

				// Press Enter to send
				this.windowsMessaging.sendKeyPress(hwnd, VK_RETURN);

				// Close chat window
				this.cancel();

				streamDeck.logger.info('[ChatCommand] Chat message sent successfully');
			}, 5);

			return true;
		} catch (error) {
			streamDeck.logger.error(`[ChatCommand] Error sending chat message: ${error}`);
			return false;
		}
	}
}
