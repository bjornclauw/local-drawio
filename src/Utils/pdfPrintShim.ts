/**
 * Script injected into the served draw.io page.
 *
 * draw.io has no offline PDF generator: `File > Export as > PDF` either POSTs
 * the diagram to convert.diagrams.net (unreachable offline) or falls back to a
 * printer popup created with `window.open()`, which Obsidian's Electron shell
 * blocks (the "Error updating preview" message). This shim replaces that popup
 * path with a local export: the diagram is posted to the host plugin, which
 * builds a real PDF.
 *
 * Hooks (most reliable first):
 *  - mxPrintPreview.prototype.open  -> holds `this.graph`, runs right before the popup
 *  - PrintDialog.createPrintPreview -> receives the graph
 *  - EditorUi.prototype.showPrintDialog / init
 *  - window.open() with no arguments -> the blocked popup itself
 * Any failure falls back to the original behaviour, so draw.io updates stay safe.
 */
export const PDF_PRINT_SHIM = `(function () {
	var MAX_WAIT_MS = 60000;
	var started = Date.now();
	var uiDone = false;
	var previewDone = false;
	var bridgeDone = false;

	function postSvg(svgStr, graph) {
		var b64 = btoa(unescape(encodeURIComponent(svgStr)));
		var target = window.parent || window.opener;
		if (!target) return;
		target.postMessage(JSON.stringify({
			event: 'export',
			format: 'pdf',
			data: 'data:image/svg+xml;base64,' + b64,
			xml: graph && graph.getXml ? graph.getXml() : null
		}), '*');
	}

	var pendingGraph = null;
	var pendingTimer = null;

	// draw.io can open one preview per page in a burst; coalesce them so a
	// multi-page print does not save several near-identical PDFs.
	function requestExport(graph) {
		if (!graph || typeof graph.getSvg !== 'function') return false;
		pendingGraph = graph;
		if (pendingTimer) return true;
		pendingTimer = setTimeout(function () {
			pendingTimer = null;
			var g = pendingGraph;
			pendingGraph = null;
			doExport(g);
		}, 150);
		return true;
	}

	function doExport(graph) {
		if (!graph || typeof graph.getSvg !== 'function') return;
		var svg;
		try {
			// 6th arg is ignoreSelection: true exports the whole diagram, false
			// exports only the selection and throws "drawing empty" when there
			// is nothing selected.
			svg = graph.getSvg(graph.background, null, null, null, null, true);
		} catch (e) {
			console.warn('[local-drawio] PDF export failed', e);
			return;
		}
		if (!svg) return;
		try {
			postSvg(mxUtils.getXml(svg), graph);
		} catch (e) {
			console.warn('[local-drawio] PDF export failed', e);
		}
	}

	function exportFromUi() {
		var ui = window.__ldUi;
		return requestExport(ui && ui.editor && ui.editor.graph);
	}

	function makeHiddenWindow() {
		var frame = document.createElement('iframe');
		frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
		document.body.appendChild(frame);
		var w = frame.contentWindow;
		try { w.print = function () {}; w.close = function () {}; w.focus = function () {}; } catch (e) { /* ignore */ }
		return w;
	}

	function patchEditorUi() {
		if (uiDone) return true;
		if (typeof window.EditorUi !== 'function' || !window.EditorUi.prototype) return false;
		var proto = window.EditorUi.prototype;
		if (typeof proto.init === 'function' && !proto.__ldInit) {
			var origInit = proto.init;
			proto.init = function () { window.__ldUi = this; return origInit.apply(this, arguments); };
			proto.__ldInit = true;
		}
		if (typeof proto.showPrintDialog === 'function' && !proto.__ldShow) {
			var origShow = proto.showPrintDialog;
			proto.showPrintDialog = function (title, callback) {
				window.__ldUi = this;
				try { if (!callback && requestExport(this.editor && this.editor.graph)) return; } catch (e) { /* ignore */ }
				return origShow.apply(this, arguments);
			};
			proto.__ldShow = true;
		}
		uiDone = true;
		return true;
	}

	function patchPreview() {
		if (previewDone) return true;

		var PP = window.mxPrintPreview;
		if (typeof PP !== 'function' || !PP.prototype || typeof PP.prototype.open !== 'function') return false;
		if (!PP.prototype.__ldOpen) {
			var origOpen = PP.prototype.open;
			PP.prototype.open = function () {
				try { window.__ldGraph = this.graph; if (this.graph) requestExport(this.graph); } catch (e) { /* ignore */ }
				return origOpen.apply(this, arguments);
			};
			PP.prototype.__ldOpen = true;
		}

		var PD = window.PrintDialog;
		if (PD && typeof PD.createPrintPreview === 'function' && !PD.__ldCpp) {
			var origCpp = PD.createPrintPreview;
			PD.createPrintPreview = function (graph) { window.__ldGraph = graph; return origCpp.apply(this, arguments); };
			PD.__ldCpp = true;
		}

		previewDone = true;
		return true;
	}

	function patchBridge() {
		if (bridgeDone) return true;
		var nativeOpen = typeof window.open === 'function' ? window.open.bind(window) : null;
		window.open = function (url, name, features) {
			if ((url == null || url === '' || url === 'about:blank') && !name) {
				try { if (!requestExport(window.__ldGraph)) exportFromUi(); } catch (e) { /* ignore */ }
				try { var w = makeHiddenWindow(); if (w) return w; } catch (e) { /* ignore */ }
			}
			return nativeOpen ? nativeOpen(url, name, features) : undefined;
		};
		bridgeDone = true;
		return true;
	}

	patchBridge();
	if (!(patchEditorUi() && patchPreview())) {
		var timer = setInterval(function () {
			patchEditorUi();
			patchPreview();
			if ((uiDone && previewDone) || Date.now() - started > MAX_WAIT_MS) clearInterval(timer);
		}, 200);
	}
})();
`;
