import { DataAdapter } from "obsidian";

interface NodeDataAdapter {
    getBasePath?: () => string;
    basePath?: string;
}

export function getVaultBasePath(adapter: DataAdapter): string {
    const nodeAdapter = adapter as unknown as NodeDataAdapter;
    return nodeAdapter.getBasePath?.() ?? nodeAdapter.basePath ?? "";
}
