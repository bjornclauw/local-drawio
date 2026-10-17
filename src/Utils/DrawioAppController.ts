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

  private saving = false;
  private saveQueued = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

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
        data = await this.inlineIfNeeded(this.file, data);
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

  private static verifiedClean = new Map<string, { mtime: number; size: number }>();

  private async inlineIfNeeded(file: TFile, data: string): Promise<string> {
    let stat: { mtime: number; size: number } | null = null;
    try {
      const s = await this.plugin.app.vault.adapter.stat(file.path);
      if (s) stat = { mtime: s.mtime, size: s.size };
    } catch {
      stat = null;
    }

    const cached = DrawioAppController.verifiedClean.get(file.path);
    if (stat && cached && stat.mtime === cached.mtime && stat.size === cached.size) {
      return data;
    }

    const inlined = await ImageEmbedder.inlineExternalImages(data);
    if (inlined === data && stat) {
      DrawioAppController.verifiedClean.set(file.path, { mtime: stat.mtime, size: stat.size });
      if (DrawioAppController.verifiedClean.size > 200) {
        for (const oldest of DrawioAppController.verifiedClean.keys()) {
          DrawioAppController.verifiedClean.delete(oldest);
          break;
        }
      }
    }
    return inlined;
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
    if (this.saving) {
      this.saveQueued = true;
      this.setEditorSaving(true, t("DRAWIO_EDITOR__SAVING"));
      return;
    }

    this.saving = true;
    this.saveQueued = false;
    this.setEditorSaving(true, t("DRAWIO_EDITOR__SAVING"), false);
    this.requestExportDelayed();
    this.armSaveTimeout();
  }

  private requestExportDelayed() {
    // Let the editor paint the spinner/status before it starts the
    // blocking export render, otherwise the feedback only appears after.
    setTimeout(() => {
      if (!this.saving) return;
      this.requestExport();
    }, 400);
  }

  private requestExport() {
    this.iframe.contentWindow?.postMessage(JSON.stringify({
      action: 'export',
      format: 'xmlsvg',
    }), this.url);
  }

  private armSaveTimeout() {
    this.clearSaveTimeout();
    this.saveTimeout = setTimeout(() => {
      this.saving = false;
      this.saveQueued = false;
      this.setEditorSaving(false, t("DRAWIO_EDITOR__SAVE_FAILED"), true);
    }, 120000);
  }

  private clearSaveTimeout() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
  }

  private finishSave(ok: boolean, cancelled = false) {
    this.clearSaveTimeout();

    if (this.saveQueued) {
      this.saveQueued = false;
      this.setEditorSaving(true, t("DRAWIO_EDITOR__SAVING"));
      this.requestExportDelayed();
      this.armSaveTimeout();
      return;
    }

    this.saving = false;
    if (ok) {
      this.setEditorSaving(false, t("DRAWIO_EDITOR__SAVED"), false);
    } else if (cancelled) {
      this.setEditorSaving(false, t("DRAWIO_EDITOR__SAVE_CANCELLED"), true);
    } else {
      this.setEditorSaving(false, t("DRAWIO_EDITOR__SAVE_FAILED"), true);
    }
  }

  private setEditorSaving(show: boolean, message: string, modified?: boolean) {
    this.iframe.contentWindow?.postMessage(JSON.stringify({
      action: 'spinner',
      show,
      message
    }), this.url);

    const status: { action: string; message: string; modified?: boolean } = { action: 'status', message };
    if (modified !== undefined) status.modified = modified;
    this.iframe.contentWindow?.postMessage(JSON.stringify(status), this.url);
  }

  async onExportData(data: DrawIoMessage) {
    try {
      const svgBase64 = data.data?.split(',')[1];
      if (!svgBase64) {
        this.finishSave(false);
        return;
      }

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
          this.finishSave(true);
          return;
        }
      }

      const newFileName = await this.Utils.getFileNameForSave();
      if (!newFileName) {
        this.finishSave(false, true);
        return;
      }

      const file = await this.plugin.app.vault.create(newFileName, svg);
      this.file = file;

      new Notice(t("DRAWIO_NOTICE__DIAGRAM_CREATED").replace("{name}", file.name));
      this.finishSave(true);

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
    } catch (error) {
      console.error("Failed to save drawio diagram", error);
      this.finishSave(false);
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