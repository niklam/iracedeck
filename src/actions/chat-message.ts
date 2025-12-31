import streamDeck, { action, SingletonAction, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { SDKController } from "../iracing/sdk-controller";
import { hasFlag } from "../iracing/utils";
import { CameraState } from "../iracing/types";
import { CameraCommand } from "../iracing/broadcast/index";

/**
 * Chat Message Action
 * Sends a custom chat message to iRacing when pressed
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.chat" })
export class ChatMessage extends SingletonAction<ChatSettings> {
	private sdkController = SDKController.getInstance();
	private cameraCommand = CameraCommand.getInstance();
	private updateInterval: NodeJS.Timeout | null = null;
	private activeContexts = new Map<string, ChatSettings>();
	private lastTitle = new Map<string, string>();

	/**
	 * When the action appears on the Stream Deck
	 */
	override async onWillAppear(ev: WillAppearEvent<ChatSettings>): Promise<void> {
		this.activeContexts.set(ev.action.id, ev.payload.settings);

		// Set default message if not configured
		if (!ev.payload.settings.message) {
			await ev.action.setSettings({
				message: ""
			});
		}

		// Start updating display
		if (!this.updateInterval) {
			this.startUpdates();
		}

		// Update immediately
		this.updateDisplay(ev.action.id, ev.payload.settings);
	}

	/**
	 * When the action disappears from the Stream Deck
	 */
	override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
		this.activeContexts.delete(ev.action.id);
		this.lastTitle.delete(ev.action.id);

		// Stop updates if no more instances
		if (this.activeContexts.size === 0) {
			this.stopUpdates();
		}
	}

	/**
	 * Start periodic updates
	 */
	private startUpdates(): void {
		this.updateInterval = setInterval(() => {
			for (const [contextId, settings] of this.activeContexts) {
				this.updateDisplay(contextId, settings);
			}
		}, 1000); // Update every second
	}

	/**
	 * Stop periodic updates
	 */
	private stopUpdates(): void {
		if (this.updateInterval) {
			clearInterval(this.updateInterval);
			this.updateInterval = null;
		}
	}

	/**
	 * Update the display for a specific context
	 */
	private async updateDisplay(contextId: string, settings: ChatSettings): Promise<void> {
		const action = streamDeck.actions.getActionById(contextId);
		if (!action) return;

		let title = "iRacing\nnot\nconnected";

		if (this.sdkController.getConnectionStatus()) {
			// Connected - show the message preview
			const message = settings.message?.trim();

			if (message) {
				// Show first few words of the message
				title = message.length > 20 ? message.substring(0, 17) + "..." : message;
			} else {
				title = "";
			}
		}

		// Only update if the title has changed
		const lastTitle = this.lastTitle.get(contextId);
		if (lastTitle !== title) {
			this.lastTitle.set(contextId, title);
			await action.setTitle(title);
		}
	}

	/**
	 * When settings are received or updated
	 */
	override async onDidReceiveSettings(ev: any): Promise<void> {
		// Update stored settings
		this.activeContexts.set(ev.action.id, ev.payload.settings);

		// Update display when settings change
		this.updateDisplay(ev.action.id, ev.payload.settings);
	}

	/**
	 * When the key is pressed
	 */
	override async onKeyDown(ev: KeyDownEvent<ChatSettings>): Promise<void> {
		streamDeck.logger.info('[ChatMessage] Key down received');

		const message = ev.payload.settings.message?.trim();

		const telemetry = this.sdkController.getCurrentTelemetry();

		if (!telemetry || !telemetry.CamCameraState) {
			streamDeck.logger.error("[ChatMessage] Couldn't get CamCameraState");

			return;
		}

		var origCamCameraState = telemetry.CamCameraState;

		// Then use hasFlag on the telemetry data
		if (hasFlag(origCamCameraState, CameraState.UIHidden)) {
			this.cameraCommand.showUI(origCamCameraState);
		}

		if (!message) {
			streamDeck.logger.info('[ChatMessage] No message to send');
			return;
		}

		// Check if connected to iRacing
		if (!this.sdkController.getConnectionStatus()) {
			streamDeck.logger.info('[ChatMessage] Not connected to iRacing');
			return;
		}

		// Send the chat message
		const success = this.sdkController.sendChatMessage(message);

		if (success) {
			streamDeck.logger.info('[ChatMessage] Message sent succesfully');
		} else {
			streamDeck.logger.warn('[ChatMessage] Sending message failed');
		}

		this.cameraCommand.setState(origCamCameraState);
	}
}

/**
 * Settings for the chat message action
 */
type ChatSettings = {
	message?: string;
};
