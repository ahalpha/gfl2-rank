type DecoderExports = WebAssembly.Exports & {
	memory: WebAssembly.Memory;
	allocate(length: number): number;
	release(pointer: number, length: number): void;
	decode_scores(pointer: number, length: number, characterCount: number): bigint;
	decode_ranks(pointer: number, length: number): bigint;
};

export type DecodedScoreData = { times: Float64Array; scores: Uint32Array; characterCount: number };
export type DecodedBossInfo = { times: Float64Array; health: bigint[] };
export type DecodedRankData = {
	times: Float64Array;
	offsets: Uint32Array;
	uids: Uint32Array;
	scores: Uint32Array;
	info: Map<number, { name: string; level: number }>;
};

let exportsPromise: Promise<DecoderExports> | undefined;
const DECODER_URL = '/rNwXd5ndHMYCbq.wasm';

async function loadDecoder(): Promise<DecoderExports> {
	if (!exportsPromise) {
		exportsPromise = WebAssembly.instantiateStreaming(fetch(DECODER_URL), {})
			.catch(async () => WebAssembly.instantiate(await (await fetch(DECODER_URL)).arrayBuffer(), {}))
			.then((result) => result.instance.exports as DecoderExports);
	}
	return exportsPromise;
}

function readResult(exports: DecoderExports, packed: bigint): Uint8Array {
	const pointer = Number(packed >> 32n);
	const length = Number(packed & 0xffff_ffffn);
	const result = new Uint8Array(exports.memory.buffer, pointer, length).slice();
	exports.release(pointer, length);
	if (result[0] === 1) throw new Error(new TextDecoder().decode(result.subarray(1)));
	return result.subarray(1);
}

async function invoke(
	buffer: ArrayBuffer,
	callback: (exports: DecoderExports, pointer: number, length: number) => bigint
): Promise<Uint8Array> {
	const exports = await loadDecoder();
	const input = new Uint8Array(buffer);
	const pointer = exports.allocate(input.length);
	try {
		new Uint8Array(exports.memory.buffer, pointer, input.length).set(input);
		return readResult(exports, callback(exports, pointer, input.length));
	} finally {
		exports.release(pointer, input.length);
	}
}

export async function decodeScoreData(buffer: ArrayBuffer, expectedCharacterCount: number): Promise<DecodedScoreData> {
	const bytes = await invoke(buffer, (exports, pointer, length) => exports.decode_scores(pointer, length, expectedCharacterCount));
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = view.getUint32(0, true);
	const characterCount = view.getUint32(4, true);
	let offset = 8;
	const times = new Float64Array(bytes.slice(offset, offset + count * 8).buffer);
	offset += count * 8;
	const scores = new Uint32Array(bytes.slice(offset, offset + count * characterCount * 4).buffer);
	return { times, scores, characterCount };
}

export async function decodeBossInfo(buffer: ArrayBuffer): Promise<DecodedBossInfo> {
	// One u64 health value has the same byte layout as two little-endian u32 values.
	const decoded = await decodeScoreData(buffer, 2);
	const health = Array.from({ length: decoded.times.length }, (_, index) => {
		const low = BigInt(decoded.scores[index * 2]);
		const high = BigInt(decoded.scores[index * 2 + 1]);
		return low | (high << 32n);
	});
	return { times: decoded.times, health };
}

export async function decodeRankData(buffer: ArrayBuffer): Promise<DecodedRankData> {
	const bytes = await invoke(buffer, (exports, pointer, length) => exports.decode_ranks(pointer, length));
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = view.getUint32(0, true);
	let offset = 4;
	const times = new Float64Array(bytes.slice(offset, offset + count * 8).buffer);
	offset += count * 8;
	const offsets = new Uint32Array(bytes.slice(offset, offset + (count + 1) * 4).buffer);
	offset += (count + 1) * 4;
	const entryCount = offsets[count];
	const uids = new Uint32Array(bytes.slice(offset, offset + entryCount * 4).buffer);
	offset += entryCount * 4;
	const scores = new Uint32Array(bytes.slice(offset, offset + entryCount * 4).buffer);
	offset += entryCount * 4;
	const infoCount = view.getUint32(offset, true);
	offset += 4;
	const info = new Map<number, { name: string; level: number }>();
	const decoder = new TextDecoder();
	for (let index = 0; index < infoCount; index += 1) {
		const uid = view.getUint32(offset, true);
		const level = view.getUint16(offset + 4, true);
		const nameLength = view.getUint32(offset + 6, true);
		offset += 10;
		info.set(uid, { name: decoder.decode(bytes.subarray(offset, offset + nameLength)), level });
		offset += nameLength;
	}
	return { times, offsets, uids, scores, info };
}
