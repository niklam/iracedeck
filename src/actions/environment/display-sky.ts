import streamDeck, { action, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { SDKController } from "../../iracing/sdk-controller";
import { TelemetryData, Skies } from "../../iracing/types";

/**
 * Display Sky Action
 * Displays current sky conditions from iRacing telemetry
 */
@action({ UUID: "fi.lampen.niklas.iracedeck.environment.display-sky" })
export class DisplaySky extends SingletonAction {
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

	private getSkyName(skies: number): string {
		switch (skies) {
			case Skies.Clear:
				return "Clear";
			case Skies.PartlyCloudy:
				return "Partly\nCloudy";
			case Skies.MostlyCloudy:
				return "Mostly\nCloudy";
			case Skies.Overcast:
				return "Overcast";
			default:
				return "N/A";
		}
	}

	private getSkyImage(skies: number): string {
		switch (skies) {
			case Skies.Clear:
				return "imgs/actions/environment/display-sky/key-clear";
			case Skies.PartlyCloudy:
				return "imgs/actions/environment/display-sky/key-partly";
			case Skies.MostlyCloudy:
				return "imgs/actions/environment/display-sky/key-mostly";
			case Skies.Overcast:
				return "imgs/actions/environment/display-sky/key-overcast";
			default:
				return "imgs/actions/environment/display-sky/key";
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
		let image = "imgs/actions/environment/display-sky/key";

		if (isConnected && telemetry) {
			const skies = telemetry.Skies;

			if (skies !== null && skies !== undefined && typeof skies === 'number') {
				title = this.getSkyName(skies);
				image = this.getSkyImage(skies);
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
