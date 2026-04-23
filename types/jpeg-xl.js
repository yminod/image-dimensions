/* eslint-disable no-bitwise */

const codestreamHeaderMaximumLength = 11;

const isRawCodestream = bytes =>
	bytes[0] === 0xFF
	&& bytes[1] === 0x0A;

const isJpegXlContainer = bytes =>
	bytes[0] === 0x00
	&& bytes[1] === 0x00
	&& bytes[2] === 0x00
	&& bytes[3] === 0x0C
	&& bytes[4] === 0x4A
	&& bytes[5] === 0x58
	&& bytes[6] === 0x4C
	&& bytes[7] === 0x20
	&& bytes[8] === 0x0D
	&& bytes[9] === 0x0A
	&& bytes[10] === 0x87
	&& bytes[11] === 0x0A;

const fixedAspectRatios = [
	[1, 1],
	[12, 10],
	[4, 3],
	[3, 2],
	[16, 9],
	[5, 4],
	[2, 1],
];

const sizeHeaderDistribution = [
	{bits: 9, offset: 1},
	{bits: 13, offset: 1},
	{bits: 18, offset: 1},
	{bits: 30, offset: 1},
];

const uint32MaximumPlusOne = 4_294_967_296;

class BitReader {
	constructor(bytes, byteOffset) {
		this.bytes = bytes;
		this.bitOffset = byteOffset * 8;
		this.valid = true;
	}

	readBits(bitCount) {
		if (this.bitOffset + bitCount > this.bytes.length * 8) {
			this.valid = false;
			return;
		}

		let value = 0;
		let multiplier = 1;

		for (let index = 0; index < bitCount; index++) {
			const byte = this.bytes[this.bitOffset >> 3];
			const bit = (byte >> (this.bitOffset & 7)) & 1;
			value += bit * multiplier;
			multiplier *= 2;
			this.bitOffset++;
		}

		return value;
	}
}

const readUint32BigEndian = (bytes, offset) => {
	if (offset + 4 > bytes.length) {
		return;
	}

	return (bytes[offset] * 0x1_00_00_00)
		+ (bytes[offset + 1] * 0x1_00_00)
		+ (bytes[offset + 2] * 0x1_00)
		+ bytes[offset + 3];
};

const readUint64BigEndian = (bytes, offset) => {
	const high = readUint32BigEndian(bytes, offset);
	const low = readUint32BigEndian(bytes, offset + 4);

	if (high === undefined || low === undefined) {
		return;
	}

	const value = (high * uint32MaximumPlusOne) + low;
	return value <= Number.MAX_SAFE_INTEGER ? value : Number.POSITIVE_INFINITY;
};

const readBoxType = (bytes, offset) => String.fromCodePoint(
	bytes[offset],
	bytes[offset + 1],
	bytes[offset + 2],
	bytes[offset + 3],
);

const readBoxHeader = (bytes, offset) => {
	if (offset + 8 > bytes.length) {
		return;
	}

	let size = readUint32BigEndian(bytes, offset);
	const type = readBoxType(bytes, offset + 4);
	let headerSize = 8;

	if (size === 1) {
		if (offset + 16 > bytes.length) {
			return;
		}

		size = readUint64BigEndian(bytes, offset + 8);
		headerSize = 16;

		if (size < headerSize) {
			return;
		}
	} else if (size !== 0 && size < headerSize) {
		return;
	}

	return {
		type,
		offset,
		size,
		headerSize,
		contentStart: offset + headerSize,
		contentEnd: size === 0 ? bytes.length : offset + size,
		unbounded: size === 0,
	};
};

const readU32 = reader => {
	const selector = reader.readBits(2);

	if (selector === undefined) {
		return;
	}

	const distribution = sizeHeaderDistribution[selector];
	const value = reader.readBits(distribution.bits);

	if (value === undefined) {
		return;
	}

	return distribution.offset + value;
};

const dimensionsFromCodestream = bytes => {
	const reader = new BitReader(bytes, 2);
	const small = reader.readBits(1) === 1;
	let height;

	if (small) {
		const heightDiv8Minus1 = reader.readBits(5);
		height = (heightDiv8Minus1 + 1) * 8;
	} else {
		height = readU32(reader);
	}

	const ratio = reader.readBits(3);
	let width;

	if (ratio === 0) {
		if (small) {
			const widthDiv8Minus1 = reader.readBits(5);
			width = (widthDiv8Minus1 + 1) * 8;
		} else {
			width = readU32(reader);
		}
	} else if (ratio !== undefined) {
		const [numerator, denominator] = fixedAspectRatios[ratio - 1];
		width = Math.floor(height * numerator / denominator);
	}

	if (!reader.valid || width === undefined || height === undefined || width <= 0 || height <= 0) {
		return;
	}

	return {
		width,
		height,
		type: 'jxl',
	};
};

const appendCodestreamPrefix = (prefix, bytes, start, end) => {
	if (prefix.length >= codestreamHeaderMaximumLength || start >= end) {
		return prefix;
	}

	const bytesToTake = Math.min(codestreamHeaderMaximumLength - prefix.length, end - start);
	const nextPrefix = new Uint8Array(prefix.length + bytesToTake);
	nextPrefix.set(prefix);
	nextPrefix.set(bytes.subarray(start, start + bytesToTake), prefix.length);
	return nextPrefix;
};

const dimensionsFromContainer = bytes => {
	let offset = 12;
	let boxIndex = 1;
	let codestreamPrefix = new Uint8Array(0);

	while (offset < bytes.length) {
		const box = readBoxHeader(bytes, offset);

		if (!box) {
			return;
		}

		boxIndex++;

		if (boxIndex === 2 && box.type !== 'ftyp') {
			return;
		}

		switch (box.type) {
			case 'ftyp': {
				if (boxIndex !== 2 || box.contentStart + 4 > bytes.length || readBoxType(bytes, box.contentStart) !== 'jxl ') {
					return;
				}

				break;
			}

			case 'jxlc': {
				const availableContentEnd = Math.min(box.contentEnd, bytes.length);
				codestreamPrefix = appendCodestreamPrefix(codestreamPrefix, bytes, box.contentStart, availableContentEnd);
				return dimensionsFromCodestream(codestreamPrefix);
			}

			case 'jxlp': {
				if (box.contentStart + 4 > bytes.length || (!box.unbounded && box.contentEnd < box.contentStart + 4)) {
					return;
				}

				const availableContentEnd = Math.min(box.contentEnd, bytes.length);
				codestreamPrefix = appendCodestreamPrefix(codestreamPrefix, bytes, box.contentStart + 4, availableContentEnd);

				const dimensions = dimensionsFromCodestream(codestreamPrefix);
				if (dimensions) {
					return dimensions;
				}

				break;
			}

			default:
		}

		if (box.unbounded || box.contentEnd > bytes.length) {
			return;
		}

		offset = box.contentEnd;
	}
};

export default function jpegXl(bytes) {
	if (bytes.length < 2) {
		return;
	}

	if (isRawCodestream(bytes)) {
		return dimensionsFromCodestream(bytes);
	}

	if (bytes.length < 12) {
		return;
	}

  if (isJpegXlContainer(bytes)) {
		return dimensionsFromContainer(bytes);
  }
}
