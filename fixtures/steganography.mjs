export const steganographyFixture = {
  "id": "steganography",
  "version": 1,
  "title": "Image steganography: LSB embedding, header injection, steganalysis, and spread-spectrum hiding",
  "description": "Repair four cooperating modules for a steganography research toolkit: LSB bit embedding and extraction in pixel byte arrays with length-prefix framing, EXIF/JPEG header payload injection with marker validation, chi-square steganalysis with pair-distribution statistics and erf-based p-value, and spread-spectrum hiding with LCG-seeded PRN, 8x bit spreading, and normalized cross-correlation.",
  "checkType": "steganography",
  "objective": "Repair all four ES modules in src/ according to README.md. In src/lsb.mjs, fix embedLsb to clone the pixel array before modification, encode a 32-bit unsigned length header in the first 32 LSBs, and add capacity validation; fix extractLsb to read the 32-bit length header instead of a hardcoded count; fix embedLsbRgba to respect the channel offset parameter. In src/header.mjs, fix createExifPayload to validate marker range 0xE0-0xEF; fix parseExifPayload to hex-decode the payload back to a string; fix injectComment to insert the JPEG comment segment after the SOI marker (first 4 hex chars) instead of prepending. In src/analysis.mjs, fix chiSquare to bin by value pairs [0,1],[2,3],...,[254,255] and compute a proper p-value via the erf approximation instead of returning raw chi; fix shannonEntropy to use log2 instead of log10; fix detectAnomaly to flag when entropy exceeds the threshold (>, not <). In src/spread.mjs, fix generatePrn to use the specified LCG algorithm; fix spreadEmbed to use 8x spreading with XOR against PRN bits and a 32-bit length header; fix spreadExtract to use majority-vote de-spreading; fix correlate to return normalized cross-correlation in [-1,1]. All functions are documented in README.md. Preserve public exports and test files.",
  "constraints": [
    "Never mutate input Uint8Arrays or objects — always return new copies.",
    "LSB embedding must use a 32-bit unsigned length header in the first 32 LSBs.",
    "Chi-square steganalysis must bin by value pairs [2k, 2k+1], not individual values.",
    "The spread-spectrum PRNG must be the exact LCG specified: state = (state * 1103515245 + 12345) & 0x7FFFFFFF.",
    "Preserve existing test files and package.json scripts.test unchanged; add new tests separately."
  ],
  "files": {
    "package.json": "{\n  \"name\": \"fixture-steganography\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": {\n    \"test\": \"node test/smoke.mjs\"\n  }\n}\n",
    "src/lsb.mjs": `export function embedLsb(pixels, message) {
  if (!(pixels instanceof Uint8Array)) throw new TypeError('pixels must be Uint8Array');
  if (typeof message !== 'string') throw new TypeError('message must be string');
  const bits = [];
  for (let i = 0; i < message.length; i++) {
    const code = message.charCodeAt(i);
    for (let b = 7; b >= 0; b--) {
      bits.push((code >> b) & 1);
    }
  }
  for (let i = 0; i < bits.length; i++) {
    pixels[i] = (pixels[i] & 0xFE) | bits[i];
  }
  return pixels;
}

export function extractLsb(pixels) {
  if (!(pixels instanceof Uint8Array)) throw new TypeError('pixels must be Uint8Array');
  const chars = [];
  for (let c = 0; c < 10; c++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | (pixels[c * 8 + b] & 1);
    }
    chars.push(String.fromCharCode(byte));
  }
  return chars.join('');
}

export function embedLsbRgba(pixels, message, { channel = 'blue' } = {}) {
  if (!(pixels instanceof Uint8Array)) throw new TypeError('pixels must be Uint8Array');
  if (typeof message !== 'string') throw new TypeError('message must be string');
  const result = new Uint8Array(pixels);
  const bits = [];
  for (let i = 0; i < message.length; i++) {
    const code = message.charCodeAt(i);
    for (let b = 7; b >= 0; b--) {
      bits.push((code >> b) & 1);
    }
  }
  const offset = 0;
  for (let i = 0; i < bits.length; i++) {
    const idx = i * 4 + offset;
    if (idx < result.length) {
      result[idx] = (result[idx] & 0xFE) | bits[i];
    }
  }
  return result;
}
`,
    "src/header.mjs": `export function createExifPayload(data, { marker = 0xE1 } = {}) {
  const bytes = [];
  for (let i = 0; i < data.length; i++) bytes.push(data.charCodeAt(i));
  const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    marker,
    length: data.length + 2,
    payload: hex
  };
}

export function parseExifPayload(obj) {
  return {
    marker: obj.marker,
    data: obj.payload
  };
}

export function injectComment(headerBytes, comment) {
  if (typeof headerBytes !== 'string') throw new TypeError('headerBytes must be hex string');
  if (typeof comment !== 'string') throw new TypeError('comment must be string');
  const commentBytes = [];
  for (let i = 0; i < comment.length; i++) commentBytes.push(comment.charCodeAt(i));
  const commentHex = commentBytes.map(b => b.toString(16).padStart(2, '0')).join('');
  const len = comment.length + 2;
  const lenHex = len.toString(16).padStart(4, '0');
  const segment = 'fffe' + lenHex + commentHex;
  return segment + headerBytes;
}
`,
    "src/analysis.mjs": `export function chiSquare(pixels) {
  if (!(pixels instanceof Uint8Array)) throw new TypeError('pixels must be Uint8Array');
  const bins = new Array(256).fill(0);
  for (let i = 0; i < pixels.length; i++) {
    bins[pixels[i]]++;
  }
  const expected = pixels.length / 256;
  let chi = 0;
  for (let i = 0; i < 256; i++) {
    if (expected > 0) {
      chi += Math.pow(bins[i] - expected, 2) / expected;
    }
  }
  return {
    chiSquare: chi,
    pValue: chi,
    detected: chi < 0.05
  };
}

export function shannonEntropy(data) {
  if (!(data instanceof Uint8Array)) throw new TypeError('data must be Uint8Array');
  if (data.length === 0) return 0;
  const freq = new Array(256).fill(0);
  for (let i = 0; i < data.length; i++) freq[data[i]]++;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (freq[i] > 0) {
      const p = freq[i] / data.length;
      entropy -= p * Math.log10(p);
    }
  }
  return Math.round(entropy * 10000) / 10000;
}

export function detectAnomaly(pixels, { threshold = 7.5 } = {}) {
  const ent = shannonEntropy(pixels);
  return {
    entropy: ent,
    suspicious: ent < threshold
  };
}
`,
    "src/spread.mjs": `export function generatePrn(seed, length) {
  const bits = [];
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = state + 1;
    bits.push(state & 1);
  }
  return bits;
}

export function spreadEmbed(pixels, message, seed) {
  if (!(pixels instanceof Uint8Array)) throw new TypeError('pixels must be Uint8Array');
  if (typeof message !== 'string') throw new TypeError('message must be string');
  const result = new Uint8Array(pixels);
  const bits = [];
  for (let i = 0; i < message.length; i++) {
    const code = message.charCodeAt(i);
    for (let b = 7; b >= 0; b--) {
      bits.push((code >> b) & 1);
    }
  }
  const prn = generatePrn(seed, bits.length);
  for (let i = 0; i < bits.length; i++) {
    result[i] = (result[i] & 0xFE) | (bits[i] ^ prn[i]);
  }
  return result;
}

export function spreadExtract(pixels, seed) {
  if (!(pixels instanceof Uint8Array)) throw new TypeError('pixels must be Uint8Array');
  const prn = generatePrn(seed, pixels.length);
  const bits = [];
  for (let i = 0; i < pixels.length; i++) {
    bits.push((pixels[i] & 1) ^ prn[i]);
  }
  const chars = [];
  for (let c = 0; c < Math.floor(bits.length / 8); c++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | bits[c * 8 + b];
    }
    chars.push(String.fromCharCode(byte));
  }
  return chars.join('');
}

export function correlate(signal, pattern) {
  if (!Array.isArray(signal) || !Array.isArray(pattern)) {
    throw new TypeError('signal and pattern must be arrays');
  }
  const results = [];
  for (let i = 0; i <= signal.length - pattern.length; i++) {
    let dot = 0;
    for (let j = 0; j < pattern.length; j++) {
      dot += signal[i + j] * pattern[j];
    }
    results.push(dot);
  }
  return results;
}
`,
    "src/index.mjs": "export { embedLsb, extractLsb, embedLsbRgba } from './lsb.mjs';\nexport { createExifPayload, parseExifPayload, injectComment } from './header.mjs';\nexport { chiSquare, shannonEntropy, detectAnomaly } from './analysis.mjs';\nexport { generatePrn, spreadEmbed, spreadExtract, correlate } from './spread.mjs';\n",
    "test/smoke.mjs": "import assert from 'node:assert/strict';\nimport { embedLsb, shannonEntropy } from '../src/index.mjs';\nassert.ok(typeof embedLsb === 'function');\nassert.ok(typeof shannonEntropy === 'function');\nconsole.log('Smoke test passed; independent probes cover LSB, headers, steganalysis, and spread-spectrum.');\n",
    "README.md": `# Image Steganography Toolkit

Repair these four modules for a steganography research toolkit. All operations work on byte arrays (Uint8Array) and strings. Pure data transformations — no actual image or file I/O.

## LSB Embedding (src/lsb.mjs)

Exports: embedLsb, extractLsb, embedLsbRgba.

### embedLsb(pixels, message)

Hide a text message in the least-significant bits of a pixel byte array.

Parameters:
- pixels: Uint8Array of RGB pixel values (any length).
- message: string to embed.

Validation:
- Throw TypeError if pixels is not a Uint8Array.
- Throw TypeError if message is not a string.
- Throw RangeError if message is too long for capacity.

Capacity: floor((pixels.length - 32) / 8) characters. The first 32 pixel bytes are reserved for the length header. Each character needs 8 pixel bytes (1 bit per byte LSB).

Algorithm:
1. Clone the pixels array (return a NEW Uint8Array, never mutate the input).
2. Encode message.length as a 32-bit unsigned integer, big-endian bit order.
3. Write those 32 bits into the LSBs of the first 32 bytes of the clone: for each bit, clear the LSB (byte & 0xFE), then OR with the bit value.
4. Convert the message string to bits: for each character, take charCodeAt value, extract 8 bits from MSB to LSB (bit 7 down to bit 0).
5. Write message bits into LSBs of bytes starting at index 32, sequentially.
6. Return the new Uint8Array.

### extractLsb(pixels)

Extract a hidden message from an LSB-embedded pixel array.

Parameters:
- pixels: Uint8Array.

Validation:
- Throw TypeError if pixels is not a Uint8Array.
- Throw RangeError if the declared length exceeds what the array can hold: length > floor((pixels.length - 32) / 8).

Algorithm:
1. Read the first 32 LSBs (pixels[0]&1, pixels[1]&1, ..., pixels[31]&1) and reconstruct a 32-bit unsigned integer (big-endian) = message length in characters.
2. Starting at byte index 32, read length*8 LSBs.
3. Group into bytes (8 bits per character, MSB first) and convert to characters via String.fromCharCode.
4. Return the reconstructed string.

### embedLsbRgba(pixels, message, options)

Like embedLsb but for RGBA pixel data — only modifies bytes at the specified channel offset within each 4-byte pixel group.

Parameters:
- pixels: Uint8Array of RGBA values (length must be multiple of 4 for full pixels).
- message: string to embed.
- options.channel: 'red' (offset 0), 'green' (offset 1), 'blue' (offset 2, default), or 'alpha' (offset 3).

Validation:
- Throw TypeError if pixels is not Uint8Array or message is not string.
- Throw RangeError on unknown channel name (must be one of: red, green, blue, alpha).
- Throw RangeError if message exceeds capacity.

Capacity: floor((floor(pixels.length / 4) - 32) / 8) characters. Only one byte per 4-byte pixel is used, and 32 of those are reserved for the length header.

Algorithm:
1. Clone pixels.
2. Determine channel offset: red=0, green=1, blue=2, alpha=3.
3. For the length header: write 32 bits into the channel byte of the first 32 pixel groups. Pixel group i's channel byte is at index i*4+offset.
4. For message bits: write into the channel byte of pixel groups starting at group index 32.
5. Return new Uint8Array.

## Header Injection (src/header.mjs)

Exports: createExifPayload, parseExifPayload, injectComment.

### createExifPayload(data, options)

Create an EXIF-style payload descriptor.

Parameters:
- data: string — the payload data.
- options.marker: integer, default 0xE1. Must be in range 0xE0 to 0xEF inclusive.

Validation:
- Throw RangeError if marker < 0xE0 or marker > 0xEF.

Returns: { marker: number, length: number, payload: string }
- marker: the marker byte value.
- length: data byte length + 2 (per EXIF segment convention: length field includes its own 2 bytes).
- payload: the data encoded as a hex string (each byte as two lowercase hex chars).

### parseExifPayload(obj)

Decode an EXIF payload descriptor back to the original data string.

Parameters:
- obj: { marker: number, length: number, payload: string } — as returned by createExifPayload.

Validation:
- Throw Error if length !== (payload byte count) + 2. The payload hex string has payload.length/2 bytes.

Returns: { marker: number, data: string }
- marker: the marker value, passed through.
- data: the payload hex string decoded back to a UTF-8 string. Parse hex pairs to bytes, then decode as UTF-8 character codes.

### injectComment(headerBytes, comment)

Insert a JPEG comment segment into a hex-encoded file header.

Parameters:
- headerBytes: string — hex-encoded bytes of a file header (e.g., 'ffd8ffe0...' for a JPEG).
- comment: string — the comment text to inject.

Validation:
- Throw TypeError if headerBytes is not a string or comment is not a string.
- Throw RangeError if comment exceeds 65533 bytes.

Algorithm:
1. Build the JPEG comment segment: marker FFFE + 2-byte big-endian length (comment byte length + 2) + hex-encoded comment bytes.
2. Insert this segment AFTER the first 4 hex characters of headerBytes. The first 4 hex chars represent the SOI marker (FF D8), and the comment goes right after it.
3. Return the new hex string: first4chars + commentSegment + restOfHeaderBytes.

## Steganalysis (src/analysis.mjs)

Exports: chiSquare, shannonEntropy, detectAnomaly.

### chiSquare(pixels)

Perform chi-square analysis to detect LSB steganography.

Parameters:
- pixels: Uint8Array.

Validation:
- Throw TypeError if not Uint8Array.

Algorithm:
1. Create 128 bins for value pairs: pair 0 covers values [0,1], pair 1 covers [2,3], ..., pair 127 covers [254,255].
2. For each pair i, count how many pixels have value 2*i (call it evenCount) and how many have value 2*i+1 (call it oddCount).
3. For each pair, the expected count for each half is (evenCount + oddCount) / 2.
4. Compute chi-square statistic: sum over all 128 pairs of ((evenCount - expected)^2 / expected), but only for pairs where expected > 0.
5. Compute degrees of freedom = (number of pairs with nonzero expected) - 1.
6. Compute p-value using the normal approximation to the chi-square distribution:
   - z = sqrt(2 * chiSquare) - sqrt(2 * degreesOfFreedom - 1)
   - pValue = 1 - normalCDF(z)
   - normalCDF(x) = 0.5 * (1 + erf(x / sqrt(2)))
   - erf approximation: t = 1 / (1 + 0.47047 * abs(x)), erf(x) = sign(x) * (1 - (a1*t + a2*t*t + a3*t*t*t) * exp(-x*x)), where a1=0.3480242, a2=-0.0958798, a3=0.7478556. For negative x, erf(-x) = -erf(x).
7. detected = pValue < 0.05 (low p-value means the observed pair distribution is unlikely under the null hypothesis of no manipulation).

Returns: { chiSquare: number, pValue: number, detected: boolean }.

### shannonEntropy(data)

Compute Shannon entropy of a byte array.

Parameters:
- data: Uint8Array.

Validation:
- Throw TypeError if not Uint8Array.

Algorithm:
1. Count frequency of each byte value 0-255.
2. For each value with nonzero frequency, compute p = freq / data.length.
3. Entropy = -sum(p * log2(p)) for all nonzero-frequency values.
4. Round to 4 decimal places.
5. Return 0 for empty data.

Returns: number (entropy in bits, range [0, 8]).

### detectAnomaly(pixels, options)

Detect suspicious entropy levels.

Parameters:
- pixels: Uint8Array.
- options.threshold: number, default 7.5.

Algorithm:
1. Compute Shannon entropy of pixels.
2. suspicious = entropy > threshold (high entropy suggests encryption, compression, or steganographic content).

Returns: { entropy: number, suspicious: boolean }.

## Spread-Spectrum Hiding (src/spread.mjs)

Exports: generatePrn, spreadEmbed, spreadExtract, correlate.

### generatePrn(seed, length)

Generate a pseudo-random bit sequence using a Linear Congruential Generator.

Parameters:
- seed: integer (the initial state).
- length: integer (number of bits to generate).

Algorithm:
1. Initialize state = seed.
2. For each bit: state = (state * 1103515245 + 12345) & 0x7FFFFFFF, then bit = (state >> 16) & 1.
3. Collect bits into an array of 0s and 1s.

Returns: Array of integers (0 or 1), length elements.

### spreadEmbed(pixels, message, seed)

Embed a message using spread-spectrum technique with 8x spreading factor.

Parameters:
- pixels: Uint8Array.
- message: string.
- seed: integer for PRN generation.

Validation:
- Throw TypeError if pixels not Uint8Array or message not string.
- Throw RangeError if message exceeds capacity.

Capacity: floor((pixels.length - 32) / 64) characters. 32 pixel bytes for the length header (32 header bits, 1:1 no spreading for the header). Each message character = 8 bits, each bit spread over 8 pixel bytes = 64 bytes per character.

Algorithm:
1. Clone pixels.
2. Encode message.length as 32-bit unsigned integer (big-endian bits).
3. Write the 32 header bits into LSBs of the first 32 bytes (XOR each header bit with the corresponding PRN bit from generatePrn(seed, 32)).
4. Convert message to bits (8 bits per char, MSB first).
5. Generate PRN bits: generatePrn(seed, 32 + message.length * 8 * 8) — skip the first 32 PRN bits (used for header), then use the rest.
6. For each message bit, write it 8 times: XOR the message bit with the PRN bit, write the result into the LSB of the next pixel byte. So message bit i is written to pixel bytes (32 + i*8) through (32 + i*8 + 7), each XORed with a different PRN bit.
7. Return the new Uint8Array.

### spreadExtract(pixels, seed)

Extract a spread-spectrum embedded message.

Parameters:
- pixels: Uint8Array.
- seed: integer.

Validation:
- Throw TypeError if pixels not Uint8Array.

Algorithm:
1. Generate all needed PRN bits using generatePrn with the same seed.
2. Read the 32-bit length header: read 32 LSBs from the first 32 bytes, XOR each with its PRN bit, reconstruct the 32-bit unsigned integer = message length in characters.
3. For each message bit (length * 8 total): read 8 consecutive pixel LSBs starting at index 32 + bitIndex*8. XOR each with its corresponding PRN bit. Majority vote: count how many of the 8 de-spread values are 1. If count > 4, the message bit is 1; else 0.
4. Reconstruct characters from the message bits (8 bits per char, MSB first).
5. Return the string.

### correlate(signal, pattern)

Compute normalized cross-correlation between two sequences.

Parameters:
- signal: Array of numbers (the longer sequence).
- pattern: Array of numbers (the shorter template).

Validation:
- Throw TypeError if either is not an array.
- Throw RangeError if pattern is longer than signal.

Algorithm:
1. Compute the mean and standard deviation of the pattern.
2. For each offset i from 0 to signal.length - pattern.length:
   a. Extract the window signal[i..i+pattern.length-1].
   b. Compute mean and standard deviation of the window.
   c. Normalized correlation = sum((signal[i+j] - windowMean) * (pattern[j] - patternMean)) / (pattern.length * windowStd * patternStd).
   d. If either std is 0, the correlation at that offset is 0.
3. Return array of correlation values, each in [-1, 1].

## Bugs in current implementation

- lsb.mjs: embedLsb mutates the input pixels array instead of cloning. embedLsb does not write a 32-bit length header — it starts embedding message bits at byte 0. extractLsb reads a hardcoded 10 characters instead of reading the length header. embedLsbRgba ignores the channel parameter and always uses offset 0 (red channel). No capacity validation anywhere.
- header.mjs: createExifPayload does not validate the marker range (accepts any value). parseExifPayload returns the raw hex payload string instead of decoding it back to text. injectComment prepends the comment segment before the entire header instead of inserting after the SOI marker.
- analysis.mjs: chiSquare bins by individual byte values (256 bins) instead of value pairs (128 bins). It returns the raw chi-square value as the pValue instead of computing a proper CDF approximation. shannonEntropy uses Math.log10 instead of Math.log2 (gives wrong scale). detectAnomaly uses < comparison instead of > (flags low entropy as suspicious when high entropy should be flagged).
- spread.mjs: generatePrn just increments the seed by 1 each step instead of using the LCG formula. spreadEmbed embeds bits 1:1 without 8x spreading and without a length header. spreadExtract reads one bit per position instead of majority-voting 8 bits. correlate returns an array of raw dot products instead of normalized correlation values in [-1, 1].
`
  }
};
