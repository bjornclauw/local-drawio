import DrawioPlugin from "main";
import { pluginUtils } from "./PluginUtils";
import { normalizePath, TFile, TFolder, WorkspaceLeaf, Notice } from "obsidian";
import { t } from "locales/I18n";
import { ImageEmbedder } from "./ImageEmbedder";

interface DrawIoMessage {
  event?: string;
  action?: string;
  data?: string;
}

export class DrawioAppController {

  private plugin: DrawioPlugin
  private iframe: HTMLIFrameElement
  private url: string
  private Utils: pluginUtils

  public file: TFile | null = null
  public fileName: string | null = null

  private leaf?: WorkspaceLeaf | null;

  constructor(plugin: DrawioPlugin, iframe: HTMLIFrameElement, url: string, leaf?: WorkspaceLeaf) {
    this.plugin = plugin
    this.iframe = iframe
    this.url = url;
    this.Utils = new pluginUtils(this.plugin)
    this.leaf = leaf ? leaf : null;
  }

  handleDrawIoMessage() {
    const listener = (event: MessageEvent) => {
      if (event.origin !== this.url) { return; }

      if (!this.iframe || event.source !== this.iframe.contentWindow) { return; }

      let data: DrawIoMessage;
      try {
        data = JSON.parse(event.data as string) as DrawIoMessage;
      } catch {
        return;
      }

      switch (data.event) {
        case "init": void this.onInit();
          break
        case "configure": void this.onConfigure();
          break
        case "save": this.onSaveData(data)
          break
        case "export": void this.onExportData(data)
          break
      }
    }

    window.addEventListener("message", listener);

    return listener;
  }

  async onInit() {
    const messageToDrawIo = {
      action: 'load',
      xml: ""
    };

    if (this.file) {
      let data = await this.plugin.app.vault.read(this.file);

      if (this.plugin.settings.embedExternalImages !== false) {
        data = await ImageEmbedder.inlineExternalImages(data);
      }

      const messageToEditDrawIo = {
        action: 'load',
        xml: data
      };

      this.fileName = normalizePath(this.file.path);

      return this.iframe.contentWindow?.postMessage(JSON.stringify(messageToEditDrawIo), this.Utils.getServerUrl("baseurl"));
    }

    return this.iframe.contentWindow?.postMessage(JSON.stringify(messageToDrawIo), this.Utils.getServerUrl("baseurl"));
  }

  async onConfigure() {
    const config = await this.buildLibrariesConfig();

    this.iframe.contentWindow?.postMessage(JSON.stringify({
      action: 'configure',
      config
    }), this.Utils.getServerUrl("baseurl"));
  }

  async buildLibrariesConfig(): Promise<object> {
    const rawFolderPath = this.plugin.settings.librariesFolder;
    const folderPath = rawFolderPath ? rawFolderPath.replace(/\/+$/, "") : "";
    if (!folderPath) return {};

    try {
      const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
      if (!(folder instanceof TFolder)) return {};

      const libFiles = folder.children
        .filter((child): child is TFile => child instanceof TFile && child.name.toLowerCase().endsWith(".xml"))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (libFiles.length === 0) return {};

      const baseUrl = this.Utils.getServerUrl("baseurl");
      const libs = libFiles.map((libFile) => {
        const title = libFile.name.replace(/\.xml$/i, "");
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const id = "vault-lib-" + (slug || "lib");
        const url = baseUrl + "/vaultlib/" + encodeURIComponent(libFile.name);

        return { id, title: { main: title }, url, preload: true };
      });

      return {
        libraries: [{
          title: { main: t("DRAWIO_EDITOR__VAULT_LIBRARIES_SECTION") },
          entries: [{
            id: "obsidian-vault-libraries",
            title: { main: t("DRAWIO_EDITOR__VAULT_LIBRARIES_SECTION") },
            libs
          }]
        }],
        defaultCustomLibraries: libs.map((lib) => "U" + encodeURIComponent(lib.url))
      };
    } catch (error) {
      console.error("Failed to build libraries config", error);
      return {};
    }
  }

  onSaveData(data: DrawIoMessage) {
    this.iframe.contentWindow?.postMessage(JSON.stringify({
      action: 'export',
      format: 'xmlsvg',
    }), this.url);
  }

  async onExportData(data: DrawIoMessage) {
    const svgBase64 = data.data?.split(',')[1];
    if (!svgBase64) return;

    const binary = atob(svgBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    let svg = new TextDecoder().decode(bytes);

    if (this.plugin.settings.embedExternalImages !== false) {
      try {
        svg = await ImageEmbedder.inlineExternalImages(svg);
      } catch (error) {
        console.warn("ImageEmbedder: export-time inline pass skipped", error);
      }
    }

    if (this.file && await this.plugin.app.vault.adapter.exists(this.file.path)) {
      let file = this.plugin.app.vault.getFileByPath(this.file.path);

      if (file) {
        if (file.path.endsWith('.drawio')) {
          const newPath = file.path.substring(0, file.path.lastIndexOf('.drawio')) + '.drawio.svg';
          await this.plugin.app.vault.rename(file, newPath);

          this.file = file;
        }

        await this.plugin.app.vault.modify(file, svg);

        new Notice(t("DRAWIO_NOTICE__DIAGRAM_SAVED").replace("{name}", file.name));
        this.Utils.refreshLeaves();
        return;
      }
    }

    const newFileName = await this.Utils.getFileNameForSave();
    if (!newFileName) return;

    const file = await this.plugin.app.vault.create(newFileName, svg);
    this.file = file;

    new Notice(t("DRAWIO_NOTICE__DIAGRAM_CREATED").replace("{name}", file.name));

    if (this.leaf) {
      const currentStatus = this.leaf.getViewState();

      await this.leaf.setViewState({
        ...currentStatus,
        state: {
          ...currentStatus.state,
          file: file
        }
      }, { history: false });
    }
  }

  public set setFiletoEdit(file: TFile) {
    this.file = file;
  }

  public get setFiletoEdit(): TFile | null {
    if (this.file) {
      return this.file;
    }

    return null;
  }
}