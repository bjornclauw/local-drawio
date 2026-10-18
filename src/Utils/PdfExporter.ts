import pako from "pako";

/**
 * Minimal single-page PDF writer: embeds raw RGBA pixels as a /DeviceRGB
 * image with an alpha /SMask, both Flate-compressed via pako.
 * Pure function with no DOM or Obsidian dependencies so it can be unit-tested.
 */
export function createPdfFromRgba(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new Error("Invalid image dimensions for PDF export");
	}
	if (rgba.length !== width * height * 4) {
		throw new Error("Pixel buffer length does not match dimensions");
	}

	const rgb = new Uint8Array(width * height * 3);
	const alpha = new Uint8Array(width * height);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
		rgb[j] = rgba[i] ?? 0;
		rgb[j + 1] = rgba[i + 1] ?? 0;
		rgb[j + 2] = rgba[i + 2] ?? 0;
		alpha[j / 3] = rgba[i + 3] ?? 0;
	}

	const rgbDeflated = pako.deflate(rgb);
	const alphaDeflated = pako.deflate(alpha);

	// 1px at 96dpi = 0.75pt; page is sized to the rendered image.
	const pageWidth = +(width * 0.75).toFixed(2);
	const pageHeight = +(height * 0.75).toFixed(2);

	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	const offsets: number[] = [0];
	let cursor = 0;
	const push = (chunk: Uint8Array) => {
		parts.push(chunk);
		cursor += chunk.length;
	};
	const pushText = (text: string) => push(enc.encode(text));

	pushText("%PDF-1.4\n");
	offsets[1] = cursor;
	pushText("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
	offsets[2] = cursor;
	pushText("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
	offsets[3] = cursor;
	pushText(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n`);
	offsets[4] = cursor;
	const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im1 Do\nQ\n`;
	pushText(`4 0 obj\n<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);
	offsets[5] = cursor;
	pushText(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgbDeflated.length} /Filter /FlateDecode /SMask 6 0 R >>\nstream\n`);
	push(rgbDeflated);
	pushText("\nendstream\nendobj\n");
	offsets[6] = cursor;
	pushText(`6 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${alphaDeflated.length} /Filter /FlateDecode >>\nstream\n`);
	push(alphaDeflated);
	pushText("\nendstream\nendobj\n");

	const xrefOffset = cursor;
	const objectCount = 7;
	let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
	for (let n = 1; n < objectCount; n++) {
		xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
	}
	pushText(xref);
	pushText(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

	const out = new Uint8Array(cursor);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
