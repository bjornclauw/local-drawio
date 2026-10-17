import { requestUrl } from "obsidian";
import pako from "pako";

const INLINE_STYLE_KEYS = ["image", "src", "imgsrc"];
const EXTERNAL_URL_START = /^https?:\/\//i;
const EXTERNAL_URL_ANYWHERE = /https?:\/\//i;
const LOCALHOST_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i;
const PROXY_MARKER = "/proxy?";

const MIME_BY_EXT: Record<string, string> = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "bmp": "image/bmp",
    "ico": "image/x-icon",
    "avif": "image/avif",
    "tif": "image/tiff",
    "tiff": "image/tiff"
};

interface MxLibraryEntry {
    [key: string]: unknown;
}

export class ImageEmbedder {
    private static cache: Map<string, string> = new Map();

    public static async inlineExternalImages(content: string): Promise<string> {
        if (!content || !this.hasExternalReference(content)) {
            return content;
        }

        try {
            const doc = new DOMParser().parseFromString(content, "application/xml");
            if (doc.querySelector("parsererror")) return content;

            const root = doc.documentElement;

            if (root.nodeName === "svg") {
                const changed = await this.inlineSvgDocument(doc, root);
                return changed ? this.serialize(root) : content;
            }

            if (root.nodeName === "mxfile") {
                const changed = await this.inlineMxFile(doc, root);
                return changed ? this.serialize(doc.documentElement) : content;
            }

            if (root.nodeName === "mxlibrary") {
                const changed = await this.inlineMxLibrary(root);
                return changed ? this.serialize(doc.documentElement) : content;
            }

            const replaced = await this.inlineStyleAttributes(root);
            return replaced > 0 ? this.serialize(doc.documentElement) : content;
        } catch (error) {
            console.warn("ImageEmbedder: inline pass skipped", error);
            return content;
        }
    }

    private static hasExternalReference(content: string): boolean {
        if (EXTERNAL_URL_ANYWHERE.test(content)) return true;
        // Compressed draw.io payloads hide their image links until inflated.
        return /<(diagram|mxfile|mxlibrary)\b/i.test(content);
    }

    private static unwrapProxyUrl(url: string): string {
        const markerIndex = url.indexOf(PROXY_MARKER);
        if (markerIndex < 0) return url;

        const queryStart = url.indexOf("?", markerIndex);
        if (queryStart < 0) return url;

        const query = url.substring(queryStart + 1);
        const params = query.split("&");
        for (const param of params) {
            const eq = param.indexOf("=");
            if (eq < 0) continue;
            if (param.slice(0, eq) !== "url") continue;
            try {
                const inner = decodeURIComponent(param.slice(eq + 1));
                if (EXTERNAL_URL_START.test(inner) && !LOCALHOST_URL.test(inner)) {
                    return inner;
                }
            } catch {
                return url;
            }
        }

        return url;
    }

    private static serialize(node: Element): string {
        return new XMLSerializer().serializeToString(node);
    }

    private static async mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
        const results = new Array<R>(items.length);
        let next = 0;

        const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
            (async () => {
                while (next < items.length) {
                    const index = next++;
                    const item = items[index];
                    if (item === undefined) continue;
                    results[index] = await fn(item);
                }
            })()
        );

        await Promise.all(workers);
        return results;
    }

    private static async inlineSvgDocument(doc: Document, svgRoot: Element): Promise<boolean> {
        const images = Array.from(svgRoot.querySelectorAll("image"));
        let changed = false;

        await this.mapWithLimit(images, 6, async (img) => {
            const href = img.getAttribute("href") || img.getAttribute("xlink:href") || "";
            if (!href || !EXTERNAL_URL_START.test(href)) return;

            const dataUri = await this.toDataUri(href);
            if (dataUri === href) return;

            changed = true;
            img.setAttribute("href", dataUri);
            if (img.hasAttribute("xlink:href")) {
                img.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", dataUri);
            }
        });

        const embeddedContent = svgRoot.getAttribute("content");
        if (embeddedContent) {
            const xml = this.decodeEmbeddedXml(embeddedContent);
            if (xml) {
                const inlined = await this.inlineExternalImages(xml);
                if (inlined !== xml) {
                    changed = true;
                    svgRoot.setAttribute("content", inlined);
                }
            }
        }

        return changed;
    }

    private static decodeEmbeddedXml(raw: string): string | null {
        try {
            let data = raw;
            if (data.charAt(0) === "&") {
                data = data
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&amp;/g, "&");
            }
            if (data.charAt(0) === "%") {
                data = decodeURIComponent(data);
            } else if (data.charAt(0) !== "<") {
                data = this.bytesToBinaryString(this.base64ToBytes(data));
                if (data.charAt(0) === "%") {
                    data = decodeURIComponent(data);
                }
            }

            return data.charAt(0) === "<" ? data : null;
        } catch {
            return null;
        }
    }

    private static async inlineMxFile(doc: Document, mxFile: Element): Promise<boolean> {
        const diagrams = mxFile.getElementsByTagName("diagram");
        let changed = false;

        for (const diagram of Array.from(diagrams)) {
            const text = (diagram.textContent || "").trim();

            if (text) {
                const xml = this.decompressDiagramText(text);
                if (!xml) continue;

                const modelDoc = new DOMParser().parseFromString(xml, "application/xml");
                if (modelDoc.querySelector("parsererror")) continue;

                const replaced = await this.inlineStyleAttributes(modelDoc.documentElement);
                if (replaced === 0) continue;

                const recompressed = this.compressDiagramText(this.serialize(modelDoc.documentElement));
                if (recompressed && recompressed !== text) {
                    diagram.textContent = recompressed;
                    changed = true;
                } else if (!recompressed) {
                    diagram.textContent = "";
                    diagram.appendChild(doc.importNode(modelDoc.documentElement, true));
                    changed = true;
                }
            } else {
                const children = Array.from(diagram.children);
                for (const child of children) {
                    const replaced = await this.inlineStyleAttributes(child);
                    if (replaced > 0) changed = true;
                }
            }
        }

        return changed;
    }

    private static async inlineMxLibrary(libraryRoot: Element): Promise<boolean> {
        const jsonText = libraryRoot.textContent || "";

        let entries: unknown;
        try {
            entries = JSON.parse(jsonText);
        } catch {
            return false;
        }

        if (!Array.isArray(entries)) return false;

        let changed = false;
        for (const rawEntry of entries) {
            if (rawEntry === null || typeof rawEntry !== "object") continue;

            const entry = rawEntry as MxLibraryEntry;

            if (typeof entry.xml === "string" && this.needsStylePass(entry.xml)) {
                const original = entry.xml;
                const inlined = await this.inlineXmlString(original);
                if (inlined !== original) {
                    entry.xml = inlined;
                    changed = true;
                }
            }

            if (typeof entry.style === "string" && this.needsStylePass(entry.style)) {
                const original = entry.style;
                const inlined = await this.inlineStyleString(original);
                if (inlined !== original) {
                    entry.style = inlined;
                    changed = true;
                }
            }

            if (typeof entry.data === "string") {
                const normalized = this.normalizeStyleDataUri(entry.data);
                if (normalized !== null) {
                    if (normalized !== entry.data) {
                        entry.data = normalized;
                        changed = true;
                    }
                } else if (EXTERNAL_URL_START.test(entry.data)) {
                    const original = entry.data;
                    const inlined = this.toStyleDataUri(await this.toDataUri(original));
                    if (inlined !== original) {
                        entry.data = inlined;
                        changed = true;
                    }
                }
            }
        }

        if (changed) {
            libraryRoot.textContent = JSON.stringify(entries);
        }

        return changed;
    }

    private static async inlineXmlString(xml: string): Promise<string> {
        // Library entries are HTML-escaped blobs that can contain nested escaped
        // markup (e.g. value="&lt;font ...&gt;") which no decode-then-parse
        // round-trip survives. Substitute inside style="..." attributes instead.
        const matches = Array.from(xml.matchAll(/style="([^"]*)"/g));
        const targets = [...new Set(
            matches
                .map((m) => m[1] ?? "")
                .filter((style) => style && this.needsStylePass(style))
        )];

        if (targets.length === 0) return xml;

        const inlined = await this.mapWithLimit(targets, 6, (style) => this.inlineStyleString(style));
        const table = new Map(targets.map((style, i) => [style, inlined[i] ?? style]));

        return xml.replace(/style="([^"]*)"/g, (full, style: string) => {
            const replacement = table.get(style);
            return replacement !== undefined && replacement !== style
                ? `style="${replacement}"`
                : full;
        });
    }

    private static needsStylePass(value: string): boolean {
        return EXTERNAL_URL_ANYWHERE.test(value) || value.includes(";base64,");
    }

    private static async inlineStyleAttributes(root: Element): Promise<number> {
        const candidates = Array.from(root.querySelectorAll("[style]")).filter((element) => {
            const style = element.getAttribute("style");
            return !!style && this.needsStylePass(style);
        });

        let replaced = 0;

        await this.mapWithLimit(candidates, 6, async (element) => {
            const style = element.getAttribute("style");
            if (!style) return;

            const inlined = await this.inlineStyleString(style);
            if (inlined !== style) {
                replaced++;
                element.setAttribute("style", inlined);
            }
        });

        return replaced;
    }

    private static async inlineStyleString(style: string): Promise<string> {
        // Heal first: splitting on ";" would shred data:image/...;base64,...
        // values before per-key handling ever sees them.
        const healed = this.healTruncatedDataUri(style);
        const parts = healed.split(";");

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (part === undefined) continue;

            const eq = part.indexOf("=");
            if (eq < 1) continue;

            const key = part.slice(0, eq).trim().toLowerCase();
            const value = part.slice(eq + 1).trim();

            if (!INLINE_STYLE_KEYS.includes(key)) continue;

            const normalized = this.normalizeStyleDataUri(value);
            if (normalized !== null) {
                if (normalized !== value) {
                    parts[i] = `${key}=${normalized}`;
                }
                continue;
            }

            if (!EXTERNAL_URL_START.test(value)) continue;

            const dataUri = await this.toDataUri(value);
            if (dataUri === value) continue;

            const styleValue = this.toStyleDataUri(dataUri);
            if (styleValue !== value) {
                parts[i] = `${key}=${styleValue}`;
            }
        }

        return parts.join(";");
    }

    private static healTruncatedDataUri(style: string): string {
        return style.replace(
            /((?:image|src|imgsrc)=data:[^;,]+);base64,([A-Za-z0-9+/=]+)/g,
            "$1,$2"
        );
    }

    private static toStyleDataUri(dataUri: string): string {
        if (dataUri.startsWith("data:") && dataUri.includes(";base64,")) {
            return dataUri.replace(";base64,", ",");
        }
        return dataUri;
    }

    private static normalizeStyleDataUri(value: string): string | null {
        const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(value.trim());
        if (!match) return null;
        return `data:${match[1]},${match[2]}`;
    }

    private static decompressDiagramText(text: string): string | null {
        try {
            if (text.charAt(0) === "<") return null;

            if (text.charAt(0) === "%") {
                return decodeURIComponent(text);
            }

            const bytes = this.base64ToBytes(text);
            const inflated = pako.inflateRaw(bytes, { to: "string" });
            const xml = decodeURIComponent(inflated);

            return xml.replace(/\uFFFD/g, "");
        } catch {
            return null;
        }
    }

    private static compressDiagramText(xml: string): string | null {
        try {
            const deflated = pako.deflateRaw(encodeURIComponent(xml));
            return this.bytesToBase64(deflated);
        } catch {
            return null;
        }
    }

    private static async toDataUri(url: string): Promise<string> {
        const cached = this.cache.get(url);
        if (cached !== undefined) return cached;

        const realUrl = this.unwrapProxyUrl(url);

        if (realUrl !== url) {
            const resolved = await this.toDataUri(realUrl);
            this.cache.set(url, resolved);
            return resolved;
        }

        if (LOCALHOST_URL.test(url)) {
            this.cache.set(url, url);
            return url;
        }

        try {
            const response = await requestUrl({
                url,
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
                }
            });
            if (response.status < 200 || response.status >= 300) {
                throw new Error(`HTTP ${response.status}`);
            }
            const bytes = new Uint8Array(response.arrayBuffer);
            if (bytes.length === 0) {
                throw new Error("empty response body");
            }
            const base64 = this.bytesToBase64(bytes);
            const mime = this.mimeFromResponse(url, response);
            const dataUri = `data:${mime};base64,${base64}`;
            this.cache.set(url, dataUri);
            return dataUri;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            console.warn("ImageEmbedder: failed to fetch, keeping external link:", url, detail);
            this.cache.set(url, url);
            return url;
        }
    }

    private static mimeFromResponse(url: string, response: { headers?: Record<string, string | undefined> }): string {
        const contentType = response?.headers?.["content-type"] || response?.headers?.["Content-Type"] || "";
        const header = contentType.toLowerCase();
        if (header.startsWith("image/")) {
            const normalized = header.split(";")[0] || "";
            return normalized.trim();
        }

        const clean = url.split("?")[0] ?? url;
        const cleaned = clean.toLowerCase();
        const dot = cleaned.lastIndexOf(".");
        if (dot > -1) {
            const ext = cleaned.substring(dot + 1);
            const mapped = MIME_BY_EXT[ext];
            if (mapped) return mapped;
        }

        return "image/png";
    }

    private static base64ToBytes(base64: string): Uint8Array {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    private static bytesToBase64(bytes: Uint8Array): string {
        let binary = "";
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
            const slice = bytes.subarray(i, i + chunk);
            binary += String.fromCharCode.apply(null, Array.from(slice) as unknown as number[]);
        }
        return btoa(binary);
    }

    private static bytesToBinaryString(bytes: Uint8Array): string {
        let binary = "";
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
            const slice = bytes.subarray(i, i + chunk);
            binary += String.fromCharCode.apply(null, Array.from(slice) as unknown as number[]);
        }
        return binary;
    }
}
