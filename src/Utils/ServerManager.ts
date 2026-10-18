import DrawioPlugin from "main";
import { MIME_TYPES } from "Types/MIME_TYPES";

import http, { Server } from "http"
import https from "https";
import path from "path";
import fs from 'fs';
import { App, normalizePath, TFile } from "obsidian";
import { t } from "locales/I18n";
import { getVaultBasePath } from "./VaultAdapterUtils";
import { ImageEmbedder } from "./ImageEmbedder";

export class ServerManager {
    private plugin: DrawioPlugin;

    constructor(plugin: DrawioPlugin) {
        this.plugin = plugin;
    }

    private createServer(): Server {
        const paths = this.getDrawioPaths(this.plugin.app, this.plugin.manifest.dir!);
        const baseDir = paths.webAppPath;

        const server = http.createServer((req, res) => {
            const rawUrl = req.url || '/';
            const cleanUrl = rawUrl.split('?')[0] ?? '/';

            if (cleanUrl === '/proxy') {
                this.serveProxy(rawUrl, res);
                return;
            }

            if (cleanUrl.startsWith('/vaultlib/')) {
                this.serveVaultLibrary(cleanUrl, res);
                return;
            }

            const relativePath = cleanUrl === '/' ? 'index.html' : cleanUrl;

            const filePath = path.normalize(path.join(baseDir, relativePath));

            if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(t("SERVER_MESSAGE_ERROR"));
                return;
            }

            const extname = String(path.extname(filePath)).toLowerCase();
            const contentType = MIME_TYPES[extname] || 'application/octet-stream';

            fs.readFile(filePath, (error, content) => {
                if (error) {
                    if (error.code === 'ENOENT') {
                        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end(`${t("SERVER_MESSAGE_FILE_NOT_FOUND")} ${relativePath}`);
                    } else {
                        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end(t("SERVER_MESSAGE_ERROR") + error.code);
                    }
                } else {
                    res.writeHead(200, {
                        'Content-Type': contentType,
                        'Access-Control-Allow-Origin': '*',
                        'Content-Security-Policy': "default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:;"
                    });
                    res.end(content);
                }
            });
        });

        const port = Number(this.plugin.settings.port) || 4444;
        server.listen(port, "127.0.0.1", () => {

        });

        return server;
    }

    startServer() {
        if (this.plugin.server) return;

        const server = this.createServer();
        this.plugin.server = server;
    }

    private serveProxy(rawUrl: string, res: http.ServerResponse) {
        try {
            const queryStart = rawUrl.indexOf("?");
            const query = queryStart >= 0 ? rawUrl.substring(queryStart + 1) : "";
            let target: string | null = null;

            for (const param of query.split("&")) {
                const eq = param.indexOf("=");
                if (eq > 0 && param.slice(0, eq) === "url") {
                    try {
                        target = decodeURIComponent(param.slice(eq + 1));
                    } catch {
                        target = null;
                    }
                    break;
                }
            }

            if (!target || !this.isSafeProxyTarget(target)) {
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(t("SERVER_MESSAGE_ERROR"));
                return;
            }

            this.fetchAndPipe(target, res, 0);
        } catch {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(t("SERVER_MESSAGE_ERROR"));
        }
    }

    private fetchAndPipe(target: string, res: http.ServerResponse, depth: number) {
        const MAX_BYTES = 25 * 1024 * 1024;

        let parsed: URL;
        try {
            parsed = new URL(target);
        } catch {
            this.endProxyError(res, 400);
            return;
        }

        if (!this.isSafeProxyTarget(target)) {
            this.endProxyError(res, 403);
            return;
        }

        const lib = parsed.protocol === "https:" ? https : http;
        const req = lib.get(target, {
            timeout: 20000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
            }
        }, (upstream) => {
            const status = upstream.statusCode ?? 500;

            if (status >= 300 && status < 400 && upstream.headers.location && depth < 3) {
                upstream.resume();
                try {
                    this.fetchAndPipe(new URL(upstream.headers.location, target).toString(), res, depth + 1);
                } catch {
                    this.endProxyError(res, 502);
                }
                return;
            }

            if (status < 200 || status >= 400) {
                upstream.resume();
                this.endProxyError(res, 502);
                return;
            }

            const contentType = upstream.headers["content-type"] ?? "application/octet-stream";
            let received = 0;
            let aborted = false;

            upstream.on("data", (chunk: Uint8Array) => {
                received += chunk.length;
                if (received > MAX_BYTES && !aborted) {
                    aborted = true;
                    console.warn("ImageEmbedder: proxy response too large, aborting:", target);
                    upstream.destroy();
                    req.destroy();
                    this.endProxyError(res, 502);
                }
            });

            upstream.on("error", () => {
                if (!res.headersSent) {
                    this.endProxyError(res, 502);
                } else {
                    res.end();
                }
            });

            res.writeHead(200, {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*'
            });
            upstream.pipe(res);
        });

        req.on("timeout", () => {
            req.destroy(new Error("proxy timeout"));
        });

        req.on("error", (error) => {
            console.warn("ImageEmbedder: proxy fetch failed:", target, error.message);
            this.endProxyError(res, 502);
        });
    }

    private endProxyError(res: http.ServerResponse, status: number) {
        if (!res.headersSent) {
            res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(t("SERVER_MESSAGE_ERROR"));
        } else {
            res.end();
        }
    }

    private isSafeProxyTarget(target: string): boolean {
        let parsed: URL;
        try {
            parsed = new URL(target);
        } catch {
            return false;
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

        const host = parsed.hostname.toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) return false;
        if (/^(10|169\.254|192\.168)\./.test(host)) return false;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;

        return true;
    }

    private serveVaultLibrary(cleanUrl: string, res: http.ServerResponse) {
        const fileName = decodeURIComponent(cleanUrl.substring('/vaultlib/'.length));

        if (!fileName || /[/\\]/.test(fileName) || fileName !== path.basename(fileName)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(t("SERVER_MESSAGE_FILE_NOT_FOUND"));
            return;
        }

        const rawFolder = this.plugin.settings.librariesFolder;
        const folder = rawFolder ? rawFolder.replace(/\/+$/, "") : "";
        if (!folder) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(t("SERVER_MESSAGE_FILE_NOT_FOUND"));
            return;
        }

        void this.serveVaultLibraryAsync(folder, fileName, res);
    }

    private async serveVaultLibraryAsync(folder: string, fileName: string, res: http.ServerResponse) {
        try {
            const vaultPath = normalizePath(`${folder}/${fileName}`);
            if (!vaultPath.startsWith(folder)) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(t("SERVER_MESSAGE_ERROR"));
                return;
            }

            const abstractFile = this.plugin.app.vault.getAbstractFileByPath(vaultPath);
            if (!(abstractFile instanceof TFile)) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(t("SERVER_MESSAGE_FILE_NOT_FOUND") + ' ' + fileName);
                return;
            }

            let content = await this.plugin.app.vault.read(abstractFile);

            if (this.plugin.settings.embedExternalImages !== false) {
                try {
                    const inlined = await ImageEmbedder.inlineExternalImages(content);
                    if (inlined !== content) {
                        content = inlined;
                        await this.plugin.app.vault.modify(abstractFile, inlined);
                    }
                } catch (error) {
                    console.warn("ImageEmbedder: library inline pass skipped", error);
                }
            }

            res.writeHead(200, {
                'Content-Type': 'text/xml; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(content);
        } catch {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(t("SERVER_MESSAGE_ERROR"));
        }
    }

    stopServer() {
        if (this.plugin.server) {
            this.plugin.server.close();
        }
    }

    private getDrawioPaths(app: App, manifestDir: string) {
        const vaultBasePath = getVaultBasePath(app.vault.adapter);
        const pluginDir = path.join(vaultBasePath, manifestDir);
        const webAppPath = path.join(pluginDir, "webapp");
        return { vaultBasePath, pluginDir, webAppPath };
    }
}