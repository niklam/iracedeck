import streamDeck, { action, SingletonAction, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { SDKController } from "../../sdk-controller.js";
import { PitCommand } from "@iracedeck/iracing-sdk";

/**
 * Do Fuel Add Action
 * Adds fuel to the pit service fuel amount when pressed
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.pit.do-fuel-add" })
export class DoFuelAdd extends SingletonAction<FuelSettings> {
	private sdkController = SDKController.getInstance();
	private pitCommand = PitCommand.getInstance();
	private updateInterval: NodeJS.Timeout | null = null;
	private activeContexts = new Map<string, FuelSettings>();
	private lastTitle = new Map<string, string>();

	/**
	 * When the action appears on the Stream Deck
	 */
	override async onWillAppear(ev: WillAppearEvent<FuelSettings>): Promise<void> {
		this.activeContexts.set(ev.action.id, ev.payload.settings);

		// Set default amount if not configured
		if (!ev.payload.settings.amount) {
			await ev.action.setSettings({
				amount: 1
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
		}, 1000);
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
	private async updateDisplay(contextId: string, settings: FuelSettings): Promise<void> {
		const action = streamDeck.actions.getActionById(contextId);
		if (!action) return;

		let title = "iRacing\nnot\nconnected";

		if (this.sdkController.getConnectionStatus()) {
			const amount = settings.amount || 1;
			title = `+${amount} L`;
		}

		const lastTitle = this.lastTitle.get(contextId);
		if (lastTitle !== title) {
			this.lastTitle.set(contextId, title);
			await action.setTitle(title);
			await action.setImage("imgs/actions/pit/do-fuel-add/key");
		}
	}

	/**
	 * When settings are received or updated
	 */
	override async onDidReceiveSettings(ev: any): Promise<void> {
		this.activeContexts.set(ev.action.id, ev.payload.settings);
		this.updateDisplay(ev.action.id, ev.payload.settings);
	}

	/**
	 * When the key is pressed
	 */
	override async onKeyDown(ev: KeyDownEvent<FuelSettings>): Promise<void> {
		streamDeck.logger.info('[DoFuelAdd] Key down received');

		// Check if connected to iRacing
		if (!this.sdkController.getConnectionStatus()) {
			streamDeck.logger.info('[DoFuelAdd] Not connected to iRacing');
			return;
		}

		// Get current fuel to add from telemetry
		const telemetry = this.sdkController.getCurrentTelemetry();
		if (!telemetry) {
			streamDeck.logger.warn('[DoFuelAdd] No telemetry data available');
			return;
		}

		const currentFuel = telemetry.PitSvFuel;
		if (currentFuel === null || currentFuel === undefined || typeof currentFuel !== 'number') {
			streamDeck.logger.warn('[DoFuelAdd] PitSvFuel not available');
			return;
		}

		const amount = ev.payload.settings.amount || 1;
		const newFuelAmount = currentFuel + amount;

		// Send the pit command with the new total fuel amount
		const success = this.pitCommand.fuel(newFuelAmount);

		if (success) {
			streamDeck.logger.info(`[DoFuelAdd] Set fuel to ${newFuelAmount}L (was ${currentFuel}L, added ${amount}L)`);
		} else {
			streamDeck.logger.warn('[DoFuelAdd] Failed to set fuel');
		}
	}
}

/**
 * Settings for the fuel add action
 */
type FuelSettings = {
	amount?: number;
};
