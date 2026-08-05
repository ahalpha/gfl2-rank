const GZIP_PREFIX = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00);

async function inflateGzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
	const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Response(stream).arrayBuffer();
}

export async function decompressGzip(buffer: ArrayBuffer, errorMessage: string): Promise<ArrayBuffer> {
	const bytes = new Uint8Array(buffer);
	const hasFullHeader = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

	if (typeof DecompressionStream === 'undefined') {
		if (hasFullHeader) throw new Error('当前浏览器不支持 gzip 数据解压');
		return buffer;
	}

	if (hasFullHeader) {
		try {
			return await inflateGzip(buffer);
		} catch {
			throw new Error(errorMessage);
		}
	}

	const restored = new Uint8Array(GZIP_PREFIX.length + bytes.length);
	restored.set(GZIP_PREFIX);
	restored.set(bytes, GZIP_PREFIX.length);
	try {
		return await inflateGzip(restored.buffer);
	} catch {
		// Content-Encoding may already have been handled by the browser.
		return buffer;
	}
}
