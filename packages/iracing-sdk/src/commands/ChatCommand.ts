/**
 * ChatCommand - Chat commands for iRacing
 *
 * Handles chat operations using the iRacing broadcast API and Windows messaging
 */
import { BroadcastCommand } from "./BroadcastCommand.js";
import { BroadcastMsg, ChatCommandMode } from "./constants.js";

/**
 * Chat commands
 */
export class ChatCommand extends BroadcastCommand {
  private static _instance: ChatCommand;

  private constructor() {
    super();
  }

  /**
   * Get the singleton instance
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
    this.logger.debug(`sendBroadcast ${ChatCommandMode[command]}, ${subCommand}`);

    return this.sendBroadcast(BroadcastMsg.ChatCommand, command, subCommand);
  }

  /**
   * Trigger a chat macro (1-15)
   * @param macroNum Macro number (1-15, as shown in app.ini)
   * @returns Success
   */
  macro(macroNum: number): boolean {
    if (macroNum < 1 || macroNum > 15) {
      this.logger.warn(`Invalid macro number: ${macroNum}. Must be 1-15.`);

      return false;
    }

    this.logger.info(`Triggering chat macro ${macroNum}`);

    // API uses 0-based indexing, but app.ini uses 1-based numbering
    return this.sendChatBroadcast(ChatCommandMode.Macro, macroNum - 1);
  }

  /**
   * Open the chat window
   * @returns Success
   */
  beginChat(): boolean {
    this.logger.debug("Opening chat window");

    return this.sendChatBroadcast(ChatCommandMode.BeginChat);
  }

  /**
   * Reply to last private message
   * @returns Success
   */
  reply(): boolean {
    this.logger.debug("Opening reply to last private message");

    return this.sendChatBroadcast(ChatCommandMode.Reply);
  }

  /**
   * Close the chat window
   * @returns Success
   */
  cancel(): boolean {
    this.logger.debug("Closing chat window");

    return this.sendChatBroadcast(ChatCommandMode.Cancel);
  }

  /**
   * Send a custom chat message to iRacing
   * Opens chat, types the message, sends it, and closes the chat window
   * @param message The message to send
   * @returns Success
   */
  sendMessage(message: string): boolean {
    if (!message || message.trim().length === 0) {
      this.logger.warn("Cannot send empty message");

      return false;
    }

    try {
      this.logger.info(`Sending chat message: "${message}"`);

      const result = this.native.sendChatMessage(message);

      if (result) {
        this.logger.info("Chat message sent successfully");
      } else {
        this.logger.error("Failed to send chat message");
      }

      return result;
    } catch (error) {
      this.logger.error(`Error sending chat message: ${error}`);

      return false;
    }
  }
}
