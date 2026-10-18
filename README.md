# Local Draw.io

Create and edit diagrams with draw.io (diagrams.net) inside Obsidian, locally and offline.

> Vendored fork of [somesanity/draw-io-obsidian](https://github.com/somesanity/draw-io-obsidian), licensed under [GNU GPLv3](./LICENSE). Plugin ID is `local-drawio`, so it installs side by side with the original.

## How it works

The plugin serves a local copy of the draw.io web app from your machine and opens it in an editor view. No account, no cloud. The only network use is the one-time download (or update) of the draw.io client from the [jgraph/drawio](https://github.com/jgraph/drawio) releases, which you trigger yourself in settings.

## Features

- Offline diagram editing in a dedicated view or modal window
- Diagrams stored as `.drawio.svg` files in your vault (regular SVGs the plugin recognizes)
- Open diagram under cursor via command or hotkey (`Mod+Alt+E`, modal with `Mod+Alt+M`)
- Right-click a diagram file to edit it, copy it as a PNG image, or export it as PDF
- Interactive diagrams in reading mode: clickable note and external links, markdown previews
- Canvas support with border, label, focus, background, and theme options
- Theme control: preview mode, edit mode, canvas, editor UI, and SVG export (adaptive, light, dark)
- External images embedded locally so diagrams survive dead links
- Vault shape libraries: every `.xml` file in a chosen folder loads into the editor
- File naming: timestamp, UUID, ISO date, or ask every time

## Requirements

- Desktop Obsidian (the plugin is desktop-only)
- On first run, open settings and download the draw.io client

## Install

1. Copy `manifest.json`, `main.js`, and `styles.css` (if present) into:
   `<Vault>/.obsidian/plugins/local-drawio/`
2. Reload Obsidian and enable **Local Draw.io** under **Settings → Community plugins**.
3. In the plugin settings, download the draw.io client.

## Use

- Select the ribbon button or run `Launch draw.io editor` to create a diagram.
- Place the cursor on a diagram link and run `Open diagram under cursor` to edit it.
- Diagrams render inline in notes, hover previews, and on canvas.

## Settings

General (save folder, file name format, local server port, client updates), display (centering, hover size, copy scale, image embedding, libraries folder), themes, canvas, and a manual update section showing the installed client version.

## Develop

```bash
npm install
npm run dev    # watch build
npm run build  # production build
```

## License

GNU GPLv3, see [LICENSE](./LICENSE). Upstream credit to [somesanity](https://github.com/somesanity) and the [draw.io](https://github.com/jgraph/drawio) project.
