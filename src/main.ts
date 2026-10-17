import { Plugin, WorkspaceLeaf } from 'obsidian';
import { DEFAULT_SETTINGS, DrawioSettings, } from "./Settings/settings";
import { PluginInit } from 'Utils/PluginInit';
import { Server } from 'http';
import { ServerManager } from 'Utils/ServerManager';
import { DrawioClientManager } from 'Utils/DrawioClientManager';
import { ExternalLinkTooltip } from 'Utils/ExternalLinkTooltip';

export default class DrawioPlugin extends Plugin {
	settings!: DrawioSettings;
	initter!: PluginInit;
	server!: Server
	serverManager!: ServerManager;
	drawioClientManager!: DrawioClientManager


	async onload() {

		// init classes
		const initter = new PluginInit(this);
		this.initter = initter;
		this.drawioClientManager = new DrawioClientManager(this);
		this.serverManager = new ServerManager(this);

		// init plugin
		await initter.loadSettings();
		initter.setPluginLanguage();
		await initter.registerCommands();
		await initter.registerViews();
		initter.registerExtensions();
		initter.addRibbonIcon();
		initter.registerPostProcessings();
		initter.registerEditorExtensions();
		initter.registerEvents();
		await this.drawioClientManager.checkAndUpdate();

		this.drawioClientManager.initDelayedCheck();
	}

	async loadSettings() {
		const storedData = (await this.loadData()) as Partial<DrawioSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, storedData ?? {});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {
		this.serverManager.stopServer();

		const tooltip = ExternalLinkTooltip.getInstance();
		tooltip.destroy(this.app);

		this.initter.canvasManager.destroy();
	}

	async activateView(ViewType: string, options?: { file?: { path: string };[key: string]: unknown }) {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;

		if (options?.file?.path) {
			const existingLeaves = workspace.getLeavesOfType(ViewType);
			for (const l of existingLeaves) {
				const currentLeafState = l.getViewState();
				const currentState = currentLeafState.state as { file?: { path?: string } } | undefined;
				if (currentState?.file?.path === options.file.path) {
					leaf = l;
					break;
				}
			}
		}

		if (leaf) {
			void workspace.revealLeaf(leaf);
			return;
		}

		leaf = workspace.getLeaf('tab');

		if (leaf) {
			await leaf.setViewState({
				type: ViewType,
				active: true,
				state: options
			});

			void workspace.revealLeaf(leaf);
		}
	}
}