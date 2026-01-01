import streamDeck, { action, SingletonAction, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { SDKController } from "../../iracing/sdk-controller";
import { TelemetryData } from "../../iracing/types";
import { PitCommand } from "../../iracing/broadcast/index";

/**
 * Tire Compound Action
 * Displays the tire compound to be used at next pit stop (PitSvTireCompound)
 * Press to toggle between dry and wet compounds
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.pit.do-tire-compound" })
export class DoTireCompound extends SingletonAction {
	private sdkController = SDKController.getInstance();
	private pitCommand = PitCommand.getInstance();
	private lastState = new Map<string, string>();

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.sdkController.subscribe(ev.action.id, (telemetry, isConnected) => {
			this.updateDisplay(ev.action.id, telemetry, isConnected);
		});
	}

	override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
		this.sdkController.unsubscribe(ev.action.id);
		this.lastState.delete(ev.action.id);
	}

	/**
	 * When the key is pressed - toggle tire compound
	 */
	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		streamDeck.logger.info('[DoTireCompound] Key down received');

		// Check if connected to iRacing
		if (!this.sdkController.getConnectionStatus()) {
			streamDeck.logger.info('[DoTireCompound] Not connected to iRacing');
			return;
		}

		const telemetry = this.sdkController.getCurrentTelemetry();
		if (!telemetry) {
			streamDeck.logger.warn('[DoTireCompound] No telemetry data available');
			return;
		}

		const currentCompound = telemetry.PitSvTireCompound;

		if (currentCompound === null || currentCompound === undefined || typeof currentCompound !== 'number') {
			streamDeck.logger.warn('[DoTireCompound] PitSvTireCompound not available');
			return;
		}

		// Toggle between compounds: 0 = Dry, 1 = Wet
		const newCompound = currentCompound === 0 ? 1 : 0;
		streamDeck.logger.info(`[DoTireCompound] Switching from ${currentCompound === 0 ? 'Dry' : 'Wet'} to ${newCompound === 0 ? 'Dry' : 'Wet'}`);

		const success = this.pitCommand.tireCompound(newCompound);
		if (success) {
			streamDeck.logger.info(`[DoTireCompound] Set tire compound to ${newCompound === 0 ? 'Dry' : 'Wet'}`);
		} else {
			streamDeck.logger.warn('[DoTireCompound] Failed to set tire compound');
		}
	}

	private async updateDisplay(
		contextId: string,
		telemetry: TelemetryData | null,
		isConnected: boolean
	): Promise<void> {
		const action = streamDeck.actions.getActionById(contextId);
		if (!action) return;

		let title = "iRacing\nnot\nconnected";
		let image = "imgs/actions/pit/do-tire-compound/key";

		if (isConnected && telemetry) {
			const tireCompound = telemetry.PitSvTireCompound;

			if (tireCompound !== null && tireCompound !== undefined && typeof tireCompound === 'number') {
				// 0 = Dry, 1 = Wet
				switch (tireCompound) {
					case 0:
						title = "Dry";
						image = "imgs/actions/pit/do-tire-compound/key-dry";
						break;
					case 1:
						title = "Wet";
						image = "imgs/actions/pit/do-tire-compound/key-wet";
						break;
					default:
						title = `TC: ${tireCompound}`;
						image = "imgs/actions/pit/do-tire-compound/key";
						break;
				}
			} else {
				title = "N/A";
			}
		}

		const stateKey = `${title}|${image}`;
		const lastState = this.lastState.get(contextId);
		if (lastState !== stateKey) {
			this.lastState.set(contextId, stateKey);
			await action.setTitle(title);
			await action.setImage(image);
		}
	}
}
