import streamDeck, { action, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { SDKController } from "../../iracing/sdk-controller";
import { TelemetryData } from "../../iracing/types";

/**
 * Display Fuel to Add Action
 * Displays the amount of fuel to be added at next pit stop (PitSvFuel)
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.pit.display-fuel-to-add" })
export class DisplayFuelToAdd extends SingletonAction {
	private sdkController = SDKController.getInstance();
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

	private async updateDisplay(
		contextId: string,
		telemetry: TelemetryData | null,
		isConnected: boolean
	): Promise<void> {
		const action = streamDeck.actions.getActionById(contextId);
		if (!action) return;

		let title = "iRacing\nnot\nconnected";
		let image = "imgs/actions/pit/display-fuel-to-add/key";

		if (isConnected && telemetry) {
			image = "imgs/actions/pit/display-fuel-to-add/key-active";
			const fuelToAdd = telemetry.PitSvFuel;

			if (fuelToAdd !== null && fuelToAdd !== undefined && typeof fuelToAdd === 'number') {
				title = fuelToAdd.toFixed(1) + "L";
			} else {
				title = "-";
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
