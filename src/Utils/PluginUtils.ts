import { t } from "locales/I18n";
import DrawioPlugin from "main";
import { App, Editor, MarkdownView, normalizePath, Notice, TFile, TFolder } from "obsidian";
import { savingNameFileFormatOption } from "Settings/settings";
import { SetFileNameModal } from "Views/SetFileNameModal";
import { createPdfFromRgba } from "./PdfExporter";

const PLUGIN_LOAD_ID = `${Date.now().toString(36)}`;

export class pluginUtils {
    private plugin: DrawioPlugin

    constructor(plugin: DrawioPlugin) {
        this.plugin = plugin;
    }

    getServerUrl(option: "baseurl" | "fullUrl"): string {
        const baseUrl = `http://localhost:${this.plugin.settings.port}`

        const configureParam = this.plugin.settings.librariesFolder ? "&configure=1" : "";
        const clibsParam = this.getCustomLibsParam(baseUrl);

        let embedmode = `${baseUrl}/?embed=1&proto=json&libraries=1&spin=1&_ld=${PLUGIN_LOAD_ID}${configureParam}${clibsParam}`;

        switch (this.plugin.settings.EditorTheme) {
            case "auto": {
                if (document.body.hasClass("theme-light")) embedmode = `${baseUrl}/?embed=1&proto=json&libraries=1&spin=1&ui=white&_ld=${PLUGIN_LOAD_ID}${configureParam}${clibsParam}`;
                if (document.body.hasClass("theme-dark")) embedmode = `${baseUrl}/?embed=1&proto=json&libraries=1&spin=1&ui=dark&_ld=${PLUGIN_LOAD_ID}${configureParam}${clibsParam}`;
                break;
            }

            case "light": embedmode = `${baseUrl}/?embed=1&proto=json&libraries=1&spin=1&ui=white&_ld=${PLUGIN_LOAD_ID}${configureParam}${clibsParam}`
                break;
            case "dark": embedmode = `${baseUrl}/?embed=1&proto=json&libraries=1&spin=1&ui=dark&_ld=${PLUGIN_LOAD_ID}${configureParam}${clibsParam}`;
                break;
        }

        switch (option) {
            case "baseurl": return baseUrl
            case "fullUrl": {
                return embedmode
            }

            default: return baseUrl
        }
    }

    private getCustomLibsParam(baseUrl: string): string {
        try {
            const rawFolder = this.plugin.settings.librariesFolder;
            const folderPath = rawFolder ? rawFolder.replace(/\/+$/, "") : "";
            if (!folderPath) return "";

            const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
            if (!(folder instanceof TFolder)) return "";

            const urls = folder.children
                .filter((child): child is TFile => child instanceof TFile && child.name.toLowerCase().endsWith(".xml"))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((libFile) => "U" + encodeURIComponent(`${baseUrl}/vaultlib/${encodeURIComponent(libFile.name)}`));

            if (urls.length === 0) return "";
            return `&clibs=${urls.join(";")}`;
        } catch {
            return "";
        }
    }

    async getFileNameForSave(extension = '.drawio.svg'): Promise<string | null> {
        const option: savingNameFileFormatOption = this.plugin.settings.savingNameFileFormat
        let defaultPath: string = "";

        switch (option) {
            case "timestamp": {
                const folder = this.plugin.settings.folder;
                const timestamp = Date.now().toString();
                const fullpath = normalizePath(`${folder}/${timestamp}${extension}`);

                if (!await this.plugin.app.vault.adapter.exists(folder)) {
                    await this.plugin.app.vault.createFolder(folder);
                }
                return fullpath;
            }

            case "uuid": {
                const folder = this.plugin.settings.folder;
                const uuid = crypto.randomUUID();
                const fullpath = normalizePath(`${folder}/${uuid}${extension}`);

                if (!await this.plugin.app.vault.adapter.exists(folder)) {
                    await this.plugin.app.vault.createFolder(folder);
                }
                return fullpath;
            }

            case "iso-date-8601": {
                const folder = this.plugin.settings.folder;
                const date = new Date();

                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hours = String(date.getHours()).padStart(2, '0');
                const minutes = String(date.getMinutes()).padStart(2, '0');
                const seconds = String(date.getSeconds()).padStart(2, '0');

                const fulldate = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
                const fullpath = normalizePath(`${folder}/${fulldate}${extension}`);

                if (!await this.plugin.app.vault.adapter.exists(folder)) {
                    await this.plugin.app.vault.createFolder(folder);
                }
                return fullpath;
            }

            case "set name": {
                const fullPath = await SetFileNameModal.openAndGetPath(
                    this.plugin.app,
                    this.plugin.settings.folder,
                    extension
                );
                return fullPath;
            }

            default: return defaultPath;
        }
    }

    findDiagramFileUnderCursor(app: App, editor: Editor, view: MarkdownView) {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);

        const linkRegex = /!\[\[([^|\]]+\.(?:drawio(?:\.svg)?))[^\]]*\]\]|!\[[^\]]*\]\(([^)\s]+?\.(?:drawio(?:\.svg)?))\)/g;

        let match: RegExpExecArray | null;

        while ((match = linkRegex.exec(line)) !== null) {
            const fullMatchText = match[0];

            let linkText = match[1] || match[2];
            if (!linkText) continue;

            linkText = linkText.trim().replace(/^<|>$/g, "");
            linkText = linkText.replace(/^\.?\//, "");
            try { linkText = decodeURIComponent(linkText); } catch (e) { console.debug(e) }

            const startIndex = match.index;
            const endIndex = startIndex + fullMatchText.length;

            if (cursor.ch >= startIndex && cursor.ch <= endIndex) {
                const linkedFile = app.metadataCache.getFirstLinkpathDest(linkText, view.file?.path ?? "");
                if (linkedFile instanceof TFile) return linkedFile;

                const byPath = app.vault.getAbstractFileByPath(linkText);
                if (byPath instanceof TFile) return byPath;

                if (linkText.endsWith(".drawio")) {
                    const alt = linkText + ".svg";
                    const altFile = app.vault.getAbstractFileByPath(alt);
                    if (altFile instanceof TFile) return altFile;
                } else if (linkText.endsWith(".drawio.svg")) {
                    const alt = linkText.replace(/\.svg$/, "");
                    const altFile = app.vault.getAbstractFileByPath(alt);
                    if (altFile instanceof TFile) return altFile;
                }

                return null;
            }
        }

        return null;
    }

    refreshLeaves() {
        const leafTypes = ['markdown', 'canvas', "image"];

        leafTypes.forEach(type => {
            this.plugin.app.workspace.getLeavesOfType(type).forEach(leaf => {
                void (async () => {
                    const state = leaf.getViewState();
                    const ephemeralState = leaf.getEphemeralState() as Record<string, unknown>;

                    await leaf.setViewState({ type: 'empty' });
                    await leaf.setViewState(state);

                    setTimeout(() => {
                        leaf.setEphemeralState(ephemeralState);
                    }, 0);
                })();
            });
        });
    }

    setDiagramsTheme(mode: "editMode" | "previewMode" | "canvasMode") {

        if (mode === "previewMode") {
            switch (this.plugin.settings.diagramThemeInPreviewMode) {
                case "auto": {
                    if (document.body.hasClass("theme-dark")) return "drawio-diagrams--darkTheme";
                    return "drawio-diagrams--lightTheme";
                };
                case "light": return "drawio-diagrams--lightTheme";
                case "dark": return "drawio-diagrams--darkTheme";
            }
        }

        if (mode === "editMode") {
            switch (this.plugin.settings.diagramThemeInEditMode) {
                case "auto": {
                    if (document.body.hasClass("theme-dark")) return "drawio-diagram--editmode--darkTheme";
                    return "drawio-diagram--editmode--lightTheme";
                };
                case "light": return "drawio-diagram--editmode--lightTheme";
                case "dark": return "drawio-diagram--editmode--darkTheme";
            }
        }

        if (mode === "canvasMode") {
            switch (this.plugin.settings.diagramThemeInCanvas) {
                case "auto": {
                    if (document.body.hasClass("theme-dark")) return "drawio-diagram--canvasMode--darkTheme";
                    return "drawio-diagram--canvasMode--lightTheme";
                };
                case "light": return "drawio-diagram--canvasMode--lightTheme";
                case "dark": return "drawio-diagram--canvasMode--darkTheme";
            }
        }

        return "";
    }

    async copySvgAsPng(file: TFile): Promise<void> {
        try {
            const svgContent = await this.plugin.app.vault.read(file);
            const canvas = await this.renderSvgToCanvas(svgContent, true);

            await new Promise<void>((resolve, reject) => {
                canvas.toBlob((pngBlob) => {
                    if (!pngBlob) {
                        reject(new Error('Failed to convert canvas to Blob'));
                        return;
                    }

                    void (async () => {
                        try {
                            await navigator.clipboard.write([
                                new ClipboardItem({ [pngBlob.type]: pngBlob })
                            ]);
                            new Notice(t("COPY_AS_IMAGE__COPY_SUCCES_NOTICE"));
                            resolve();
                        } catch (clipboardError) {
                            reject(clipboardError instanceof Error
                                ? clipboardError
                                : new Error(String(clipboardError)));
                        }
                    })();
                }, 'image/png');
            });

        } catch (error) {
            console.error(t("COPY_AS_IMAGE__EXPORT_ERROR"), error);
            new Notice(t("COPY_AS_IMAGE__COPY_FAILED"));
        }
    }

    async exportFileAsPdf(file: TFile): Promise<void> {
        try {
            const svgContent = await this.plugin.app.vault.read(file);
            const pdf = await this.svgToPdfBytes(svgContent);

            const target = await this.getFileNameForSave(".pdf");
            if (!target) {
                new Notice(t("DRAWIO_EDITOR__SAVE_CANCELLED"));
                return;
            }

            const created = await this.plugin.app.vault.createBinary(target, pdf.buffer as ArrayBuffer);
            const name = target.split("/").pop() ?? target;
            const notice = new Notice(t("DRAWIO_NOTICE__EXPORT_SAVED").replace("{name}", name));
            notice.messageEl.addClass("drawio-notice-clickable");
            notice.messageEl.onclick = () => {
                void (async () => {
                    const leaf = this.plugin.app.workspace.getLeaf("tab");
                    await leaf.openFile(created);
                })();
            };
        } catch (error) {
            console.error(t("COPY_AS_IMAGE__EXPORT_ERROR"), error);
            new Notice(t("DRAWIO_EDITOR__EXPORT_FAILED"));
        }
    }

    async svgToPdfBytes(svgContent: string): Promise<Uint8Array> {
        const canvas = await this.renderSvgToCanvas(svgContent, false);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error(t("CANVAS_MANAGER__FAILED_GET_CONTEXT"));
        }
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return createPdfFromRgba(canvas.width, canvas.height, pixels.data);
    }

    private renderSvgToCanvas(svgContent: string, stripWhiteBackground: boolean): Promise<HTMLCanvasElement> {
        let svg = svgContent;
        if (stripWhiteBackground) {
            svg = svg.replace(/<rect[^>]*fill\s*=\s*["'](?:#ffffff|rgb\(255,\s*255,\s*255\)|white)["'][^>]*\/>/gi, '');
            svg = svg.replace(/(style=[^>]*background-color:\s*)(?:#ffffff|white|rgb\(255,\s*255,\s*255\))/gi, '$1transparent');
        }

        const encodedBytes = new TextEncoder().encode(svg);
        let binary = "";
        for (const byte of encodedBytes) {
            binary += String.fromCharCode(byte);
        }
        const base64Svg = btoa(binary);
        const url = `data:image/svg+xml;base64,${base64Svg}`;

        const scaleFactor = Number(this.plugin.settings.scaleCopyDiagramAsImage) || 4;

        return new Promise<HTMLCanvasElement>((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';

            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');

                    const originalWidth = img.naturalWidth || 800;
                    const originalHeight = img.naturalHeight || 600;

                    canvas.width = originalWidth * scaleFactor;
                    canvas.height = originalHeight * scaleFactor;

                    img.width = canvas.width;
                    img.height = canvas.height;

                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        throw new Error(t("CANVAS_MANAGER__FAILED_GET_CONTEXT"));
                    }

                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';

                    ctx.clearRect(0, 0, canvas.width, canvas.height);

                    ctx.scale(scaleFactor, scaleFactor);

                    ctx.drawImage(img, 0, 0, originalWidth, originalHeight);
                    resolve(canvas);
                } catch (err) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            };

            img.onerror = () => reject(new Error('Failed to load SVG'));
            img.src = url;
        });
    }
}