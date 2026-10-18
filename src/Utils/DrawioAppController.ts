import DrawioPlugin from "main";
import { pluginUtils } from "./PluginUtils";
import { normalizePath, TFile, TFolder, WorkspaceLeaf, Notice } from "obsidian";
import { t } from "locales/I18n";
import { ImageEmbedder } from "./ImageEmbedder";

interface DrawIoMessage {
  event?: string;
  action?: string;
  data?: string;
  format?: string;
  xml?: string;
}

const EXPORT_FORMAT_EXTENSIONS: Record<string, string> = {
  xmlsvg: ".drawio.svg",
  svg: ".drawio.svg",
  xmlpng: ".png",
  png: ".png",
  jpg: ".jpg",
  jpeg: ".jpg",
  webp: ".webp",
  xml: ".drawio",
  pdf: ".pdf",
  html: ".html",
  html2: ".html",
  json: ".json"
};

const TEXT_EXPORT_EXTENSIONS = [".drawio.svg", ".drawio", ".html", ".json"];

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
  private pendingSaveExport = false;
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
      xml: "",
      exportProtocol: true
    };

    if (this.file) {
      let data = await this.plugin.app.vault.read(this.file);

      if (this.plugin.settings.embedExternalImages !== false) {
        data = await this.inlineIfNeeded(this.file, data);
      }

      const messageToEditDrawIo = {
        action: 'load',
        xml: data,
        exportProtocol: true
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
    this.pendingSaveExport = true;
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
    if (!this.pendingSaveExport) {
      await this.handleUserExport(data);
      return;
    }
    this.pendingSaveExport = false;

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

    svg = this.pinExportTheme(svg);

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

  private async handleUserExport(data: DrawIoMessage) {
    const format = (data.format ?? "svg").toLowerCase();
    this.setEditorSaving(true, t("DRAWIO_EDITOR__EXPORTING"));

    try {
      let text: string | null = null;
      let bytes: Uint8Array | null = null;
      let mime = "";

      if (!data.data && format === "xml" && data.xml) {
        text = data.xml;
        mime = "application/xml";
      } else if (data.data) {
        const decoded = this.decodeExportDataUri(data.data);
        if (!decoded) {
          console.error("Failed to decode drawio export", format, data.data.slice(0, 120));
          this.setEditorSaving(false, t("DRAWIO_EDITOR__EXPORT_FAILED"));
          return;
        }
        bytes = decoded.bytes;
        mime = decoded.mime;
      } else {
        console.error("Drawio export arrived without data", format);
        this.setEditorSaving(false, t("DRAWIO_EDITOR__EXPORT_FAILED"));
        return;
      }

      const ext = EXPORT_FORMAT_EXTENSIONS[format] ?? this.guessExportExtension(mime);
      const isText = TEXT_EXPORT_EXTENSIONS.includes(ext) || mime === "image/svg+xml" || mime.startsWith("text/");

      if (isText) {
        text = new TextDecoder().decode(bytes ?? new Uint8Array());
        bytes = null;

        if (this.plugin.settings.embedExternalImages !== false) {
          text = await ImageEmbedder.inlineExternalImages(text);
        }

        if (ext === ".drawio.svg" || ext === ".drawio") {
          text = this.pinExportTheme(text);
        }
      }

      const target = await this.Utils.getFileNameForSave(ext);
      if (!target) {
        this.setEditorSaving(false, t("DRAWIO_EDITOR__SAVE_CANCELLED"));
        return;
      }

      let created: TFile;
      if (text !== null && isText) {
        created = await this.plugin.app.vault.create(target, text);
      } else if (bytes) {
        created = await this.plugin.app.vault.createBinary(target, bytes.buffer as ArrayBuffer);
      } else {
        console.error("Drawio export produced no content", format);
        this.setEditorSaving(false, t("DRAWIO_EDITOR__EXPORT_FAILED"));
        return;
      }

      const name = target.split("/").pop() ?? target;
      const notice = new Notice(t("DRAWIO_NOTICE__EXPORT_SAVED").replace("{name}", name));
      notice.messageEl.addClass("drawio-notice-clickable");
      notice.messageEl.onclick = () => {
        void (async () => {
          const leaf = this.plugin.app.workspace.getLeaf("tab");
          await leaf.openFile(created);
        })();
      };
      this.setEditorSaving(false, t("DRAWIO_EDITOR__EXPORTED"));
    } catch (error) {
      console.error("Failed to save drawio export", error);
      this.setEditorSaving(false, t("DRAWIO_EDITOR__EXPORT_FAILED"));
    }
  }

  private decodeExportDataUri(dataUri: string): { bytes: Uint8Array; mime: string } | null {
    const trimmed = dataUri.trim();

    if (!trimmed.startsWith("data:")) {
      if (trimmed.startsWith("<svg")) {
        return { bytes: new TextEncoder().encode(trimmed), mime: "image/svg+xml" };
      }
      if (trimmed.startsWith("<")) {
        return { bytes: new TextEncoder().encode(trimmed), mime: "application/xml" };
      }
      return null;
    }

    const comma = trimmed.indexOf(",");
    if (comma < 0) return null;

    const meta = trimmed.slice(0, comma);
    const payload = trimmed.slice(comma + 1);
    const mime = meta.slice(5).split(";")[0] ?? "application/octet-stream";

    try {
      if (meta.includes(";base64")) {
        const binary = atob(payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return { bytes, mime };
      }

      return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime };
    } catch {
      return null;
    }
  }

  private guessExportExtension(mime: string): string {
    const clean = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    switch (clean) {
      case "image/svg+xml": return ".drawio.svg";
      case "image/png": return ".png";
      case "image/jpeg": return ".jpg";
      case "image/webp": return ".webp";
      case "application/pdf": return ".pdf";
      default: return ".drawio.svg";
    }
  }

  private pinExportTheme(svg: string): string {
    const theme = this.plugin.settings.exportTheme ?? "adaptive";
    if (theme === "adaptive") return svg;
    if (!svg.includes("light-dark(") && !svg.includes("--ge-adaptive-bg")) return svg;

    const side: "light" | "dark" = theme === "dark" ? "dark" : "light";
    let out = this.resolveGeAdaptiveBg(svg, side);
    out = this.resolveLightDark(out, side);
    out = this.resolveVarFallback(out, "--ge-adaptive-bg");
    out = this.resolveVarFallback(out, "--ge-dark-color");
    return out;
  }

  private extractBalanced(text: string, openIndex: number): { inner: string; end: number } | null {
    if (text.charAt(openIndex) !== "(") return null;
    let depth = 0;
    for (let j = openIndex; j < text.length; j++) {
      const ch = text.charAt(j);
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return { inner: text.slice(openIndex + 1, j), end: j };
      }
    }
    return null;
  }

  private splitTopLevel(segment: string): [string, string] | null {
    let depth = 0;
    for (let j = 0; j < segment.length; j++) {
      const ch = segment.charAt(j);
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        return [segment.slice(0, j).trim(), segment.slice(j + 1).trim()];
      }
    }
    return null;
  }

  private resolveLightDark(text: string, side: "light" | "dark"): string {
    const token = "light-dark(";
    let out = "";
    let i = 0;
    while (true) {
      const start = text.indexOf(token, i);
      if (start < 0) {
        out += text.slice(i);
        break;
      }
      const paren = this.openParenAt(text, start, token);
      const parsed = paren < 0 ? null : this.extractBalanced(text, paren);
      if (!parsed) {
        out += text.slice(i);
        break;
      }
      const parts = this.splitTopLevel(parsed.inner);
      out += text.slice(i, start) + (parts ? (side === "light" ? parts[0] : parts[1]) : parsed.inner);
      i = parsed.end + 1;
    }
    return out;
  }

  private openParenAt(text: string, tokenStart: number, token: string): number {
    const paren = text.indexOf("(", tokenStart);
    if (paren < 0 || paren > tokenStart + token.length) return -1;
    return paren;
  }

  private resolveVarFallback(text: string, name: string): string {
    const token = `var(${name},`;
    let out = "";
    let i = 0;
    while (true) {
      const start = text.indexOf(token, i);
      if (start < 0) {
        out += text.slice(i);
        break;
      }
      const paren = this.openParenAt(text, start, token);
      const parsed = paren < 0 ? null : this.extractBalanced(text, paren);
      const parts = parsed ? this.splitTopLevel(parsed.inner) : null;
      if (!parsed || !parts) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, start) + parts[1];
      i = parsed.end + 1;
    }
    return out;
  }

  private resolveGeAdaptiveBg(text: string, side: "light" | "dark"): string {
    if (side === "light") return text;
    const keyIndex = text.indexOf("--ge-adaptive-bg:");
    if (keyIndex < 0) return text;
    const token = "light-dark(";
    const tokenIndex = text.indexOf(token, keyIndex);
    if (tokenIndex < 0) return text;
    const parsed = this.extractBalanced(text, tokenIndex + token.length - 1);
    if (!parsed) return text;
    const parts = this.splitTopLevel(parsed.inner);
    if (!parts) return text;
    const dark = parts[1];
    const varToken = "var(--ge-adaptive-bg,";
    let out = "";
    let i = 0;
    while (true) {
      const start = text.indexOf(varToken, i);
      if (start < 0) {
        out += text.slice(i);
        break;
      }
      const paren = this.openParenAt(text, start, varToken);
      const ref = paren < 0 ? null : this.extractBalanced(text, paren);
      if (!ref) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, start) + dark;
      i = ref.end + 1;
    }
    return out;
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