/** Only bounded raster data is stored; SVG/URLs and arbitrary remote fetches are rejected. */
export function validAvatar(value: string): boolean {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || value.length > 180000) return false;
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.toString('base64') !== match[2] || bytes.length < 24) return false;
  if (match[1] === 'png')
    return (
      bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
      bytes.readUInt32BE(16) > 0 &&
      bytes.readUInt32BE(20) > 0 &&
      bytes.readUInt32BE(16) <= 512 &&
      bytes.readUInt32BE(20) <= 512
    );
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
    return false;
  let dimensions = false;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++]!;
    if (marker === 218) return dimensions;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) return false;
      const height = bytes.readUInt16BE(offset + 3),
        width = bytes.readUInt16BE(offset + 5);
      if (!width || !height || width > 512 || height > 512) return false;
      dimensions = true;
    }
    offset += length;
  }
  return false;
}
