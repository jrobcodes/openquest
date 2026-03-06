/**
 * Extract zone map images from WoW CASC data.
 *
 * WoW stores zone maps as grids of BLP texture tiles, referenced via:
 *   UiMap → UiMapArt → UiMapArtTile (each tile has a FileDataID)
 *
 * This script:
 * 1. Extracts UiMap, UiMapArt, UiMapArtTile DB2 tables
 * 2. Finds tiles for our 4 Midnight zones
 * 3. Fetches each BLP tile and decodes to raw RGBA
 * 4. Stitches tiles into a single PNG per zone via sharp
 */

import { CASCClient, WDCReader, DBDParser } from '@rhyster/wow-casc-dbc';
import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = join(import.meta.dirname, '..', 'website', 'public', 'maps');

// Midnight zone UiMapIDs
const ZONES: Record<string, number> = {
  eversong: 2395,
  zulaman: 2437,
  harandar: 2413,
  voidstorm: 2405,
};

const TILE_SIZE = 256; // BLP tiles are 256x256

type ColumnData = number | bigint | string | undefined | (number | bigint | string | undefined)[];

function serializeRow(row: Record<string, ColumnData>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (typeof val === 'bigint') out[key] = Number(val);
    else if (Array.isArray(val)) out[key] = val.map(v => typeof v === 'bigint' ? Number(v) : v);
    else out[key] = val;
  }
  return out;
}

async function extractDB2(client: CASCClient, tableName: string): Promise<Record<string, unknown>[]> {
  const dbPath = `dbfilesclient/${tableName}.db2`;
  const fileDataID = client.getFileDataIDByName(dbPath);
  if (fileDataID === undefined) throw new Error(`No fileDataID for ${dbPath}`);

  const cKeys = client.getContentKeysByFileDataID(fileDataID);
  if (!cKeys?.length) throw new Error(`No content keys for ${dbPath}`);

  const enUSFlag = CASCClient.LocaleFlags.enUS;
  const cKey = cKeys.find(k => (k.localeFlags & enUSFlag) !== 0) ?? cKeys[0];
  const result = await client.getFileByContentKey(cKey.cKey, true);
  const blocks = result.type === 'partial' ? result.blocks : undefined;
  const reader = new WDCReader(result.buffer, blocks ?? []);
  const parser = await DBDParser.parse(reader);

  const ids = parser.getAllIDs();
  return ids.map(id => {
    const row = parser.getRowData(id);
    return row ? { _ID: id, ...serializeRow(row) } : null;
  }).filter(Boolean) as Record<string, unknown>[];
}

/**
 * Decode a BLP file to raw RGBA pixel buffer.
 * BLP2 format: header tells us encoding (JPEG, DXTC, or uncompressed).
 * Most WoW map tiles use DXT1 or DXT5 compression.
 */
function decodeBLP(buffer: Buffer): { width: number; height: number; data: Buffer } {
  const magic = buffer.toString('ascii', 0, 4);
  if (magic !== 'BLP2') throw new Error(`Not a BLP2 file (got ${magic})`);

  // BLP2 header layout:
  //   0-3:   magic "BLP2"
  //   4-7:   type (uint32) — 0=JPEG, 1=DirectX
  //   8:     encoding (uint8) — 1=uncompressed/palette, 2=DXTn, 3=uncompressed+alpha
  //   9:     alphaDepth (uint8) — 0, 1, 4, or 8
  //   10:    alphaEncoding (uint8) — 0=DXT1, 1=DXT3, 7=DXT5 (when encoding=2)
  //   11:    hasMips (uint8)
  //   12-15: width, 16-19: height
  //   20-83: mipOffsets[16], 84-147: mipSizes[16]
  //   148-1171: palette[256] (only when encoding=1)
  const encoding = buffer.readUInt8(8);
  const alphaDepth = buffer.readUInt8(9);
  const alphaEncoding = buffer.readUInt8(10);
  const width = buffer.readUInt32LE(12);
  const height = buffer.readUInt32LE(16);

  const mipOffsets: number[] = [];
  const mipSizes: number[] = [];
  for (let i = 0; i < 16; i++) {
    mipOffsets.push(buffer.readUInt32LE(20 + i * 4));
    mipSizes.push(buffer.readUInt32LE(84 + i * 4));
  }

  const mipData = buffer.subarray(mipOffsets[0], mipOffsets[0] + mipSizes[0]);
  const pixels = Buffer.alloc(width * height * 4);

  if (encoding === 2) {
    // DXT compressed
    if (alphaEncoding === 0) {
      decodeDXT1(mipData, width, height, pixels);
    } else if (alphaEncoding === 1) {
      // DXT3 — treat as DXT1 for now (rare in map tiles)
      decodeDXT1(mipData, width, height, pixels);
    } else {
      decodeDXT5(mipData, width, height, pixels);
    }
  } else if (encoding === 1) {
    // Palettized (palette at offset 148, 256 BGRA entries)
    const palette = buffer.subarray(148, 148 + 256 * 4);
    decodePalettized(mipData, palette, width, height, alphaDepth, pixels);
  } else {
    // Uncompressed BGRA
    for (let i = 0; i < width * height; i++) {
      pixels[i * 4] = mipData[i * 4 + 2];
      pixels[i * 4 + 1] = mipData[i * 4 + 1];
      pixels[i * 4 + 2] = mipData[i * 4];
      pixels[i * 4 + 3] = mipData[i * 4 + 3];
    }
  }

  return { width, height, data: pixels };
}

function rgb565(c: number): [number, number, number] {
  return [
    ((c >> 11) & 0x1F) * 255 / 31 | 0,
    ((c >> 5) & 0x3F) * 255 / 63 | 0,
    (c & 0x1F) * 255 / 31 | 0,
  ];
}

function decodeDXT1(data: Buffer, width: number, height: number, out: Buffer) {
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  let offset = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const c0 = data.readUInt16LE(offset); offset += 2;
      const c1 = data.readUInt16LE(offset); offset += 2;
      const lookup = data.readUInt32LE(offset); offset += 4;

      const [r0, g0, b0] = rgb565(c0);
      const [r1, g1, b1] = rgb565(c1);
      const colors: [number, number, number, number][] = [
        [r0, g0, b0, 255],
        [r1, g1, b1, 255],
        c0 > c1
          ? [(2*r0+r1)/3|0, (2*g0+g1)/3|0, (2*b0+b1)/3|0, 255]
          : [(r0+r1)/2|0, (g0+g1)/2|0, (b0+b1)/2|0, 255],
        c0 > c1
          ? [(r0+2*r1)/3|0, (g0+2*g1)/3|0, (b0+2*b1)/3|0, 255]
          : [0, 0, 0, 0],
      ];

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const idx = (py * 4 + px) * 2;
          const ci = (lookup >> idx) & 0x3;
          const pi = (y * width + x) * 4;
          out[pi] = colors[ci][0];
          out[pi+1] = colors[ci][1];
          out[pi+2] = colors[ci][2];
          out[pi+3] = colors[ci][3];
        }
      }
    }
  }
}

function decodeDXT5(data: Buffer, width: number, height: number, out: Buffer) {
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  let offset = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // Alpha block
      const a0 = data[offset++];
      const a1 = data[offset++];
      const aBits = [
        data[offset] | (data[offset+1] << 8) | (data[offset+2] << 16),
        data[offset+3] | (data[offset+4] << 8) | (data[offset+5] << 16),
      ];
      offset += 6;

      const alphas = [a0, a1, 0, 0, 0, 0, 0, 0];
      if (a0 > a1) {
        for (let i = 2; i < 8; i++) alphas[i] = ((8-i)*a0 + (i-1)*a1) / 7 | 0;
      } else {
        for (let i = 2; i < 6; i++) alphas[i] = ((6-i)*a0 + (i-1)*a1) / 5 | 0;
        alphas[6] = 0; alphas[7] = 255;
      }

      // Color block (same as DXT1)
      const c0 = data.readUInt16LE(offset); offset += 2;
      const c1 = data.readUInt16LE(offset); offset += 2;
      const lookup = data.readUInt32LE(offset); offset += 4;

      const [r0, g0, b0] = rgb565(c0);
      const [r1, g1, b1] = rgb565(c1);
      const colors = [
        [r0, g0, b0],
        [r1, g1, b1],
        [(2*r0+r1)/3|0, (2*g0+g1)/3|0, (2*b0+b1)/3|0],
        [(r0+2*r1)/3|0, (g0+2*g1)/3|0, (b0+2*b1)/3|0],
      ];

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const pixelIdx = py * 4 + px;
          const ci = (lookup >> (pixelIdx * 2)) & 0x3;
          const aBlockIdx = pixelIdx < 8 ? 0 : 1;
          const aBitIdx = pixelIdx < 8 ? pixelIdx * 3 : (pixelIdx - 8) * 3;
          const ai = (aBits[aBlockIdx] >> aBitIdx) & 0x7;
          const pi = (y * width + x) * 4;
          out[pi] = colors[ci][0];
          out[pi+1] = colors[ci][1];
          out[pi+2] = colors[ci][2];
          out[pi+3] = alphas[ai];
        }
      }
    }
  }
}

function decodePalettized(data: Buffer, palette: Buffer, w: number, h: number, alphaBits: number, out: Buffer) {
  const pixelCount = w * h;
  // First pixelCount bytes: palette indices
  // Following bytes: alpha data (alphaBits per pixel, packed)
  const alphaOffset = pixelCount;

  for (let i = 0; i < pixelCount; i++) {
    const ci = data[i];
    const pi = i * 4;
    // Palette is BGRA format
    out[pi] = palette[ci * 4 + 2];     // R
    out[pi + 1] = palette[ci * 4 + 1]; // G
    out[pi + 2] = palette[ci * 4];     // B

    if (alphaBits === 0) {
      out[pi + 3] = 255;
    } else if (alphaBits === 1) {
      const byteIdx = alphaOffset + (i >> 3);
      const bitIdx = i & 7;
      out[pi + 3] = (data[byteIdx] >> bitIdx) & 1 ? 255 : 0;
    } else if (alphaBits === 2) {
      const byteIdx = alphaOffset + (i >> 2);
      const shift = (i & 3) * 2;
      const val = (data[byteIdx] >> shift) & 3;
      out[pi + 3] = val * 85; // 0→0, 1→85, 2→170, 3→255
    } else if (alphaBits === 4) {
      const byteIdx = alphaOffset + (i >> 1);
      const val = (i & 1) ? (data[byteIdx] >> 4) & 0xF : data[byteIdx] & 0xF;
      out[pi + 3] = val * 17; // 0→0, 15→255
    } else {
      // 8-bit alpha
      out[pi + 3] = data[alphaOffset + i] ?? 255;
    }
  }
}

async function main() {
  console.log('OpenQuest — Zone Map Extraction');
  console.log('================================\n');

  const version = await CASCClient.getProductVersion('us', 'wow');
  if (!version) throw new Error('Could not fetch WoW product version');
  console.log(`Build: ${version.VersionsName}\n`);

  const client = new CASCClient('us', 'wow', version);
  await client.init();
  await client.loadRemoteListFile();
  await client.loadRemoteTACTKeys();

  // Extract UiMap-related DB2 tables
  console.log('Extracting map DB2 tables...');
  const uiMapXMapArts = await extractDB2(client, 'uimapxmapart');
  const uiMapArtTiles = await extractDB2(client, 'uimaparttile');

  console.log(`  UiMapXMapArt: ${uiMapXMapArts.length} rows`);
  console.log(`  UiMapArtTile: ${uiMapArtTiles.length} rows\n`);

  await mkdir(OUT_DIR, { recursive: true });

  for (const [zoneKey, mapId] of Object.entries(ZONES)) {
    console.log(`\n--- ${zoneKey} (UiMapID ${mapId}) ---`);

    // Find the UiMapArtID via UiMapXMapArt linking table
    const xMapArt = uiMapXMapArts.find(x => (x.UiMapID as number) === mapId);
    if (!xMapArt) {
      console.error(`  No UiMapXMapArt found for UiMapID ${mapId}`);
      continue;
    }

    const artId = xMapArt.UiMapArtID as number;
    console.log(`  Art ID: ${artId}`);

    // Get tiles for this art
    const tiles = uiMapArtTiles.filter(t =>
      (t.UiMapArtID as number) === artId
    );

    if (tiles.length === 0) {
      console.error(`  No tiles found for art ${artId}`);
      continue;
    }

    // Determine grid dimensions from tile row/col indices
    let maxRow = 0, maxCol = 0;
    for (const t of tiles) {
      const row = t.RowIndex as number;
      const col = t.ColIndex as number;
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
    const gridRows = maxRow + 1;
    const gridCols = maxCol + 1;
    const totalWidth = gridCols * TILE_SIZE;
    const totalHeight = gridRows * TILE_SIZE;
    console.log(`  Grid: ${gridCols}x${gridRows} tiles (${totalWidth}x${totalHeight}px)`);
    console.log(`  Fetching ${tiles.length} tiles...`);

    // Fetch and decode each tile
    const composites: sharp.OverlayOptions[] = [];
    let fetched = 0;

    for (const tile of tiles) {
      const fileDataID = tile.FileDataID as number;
      const row = tile.RowIndex as number;
      const col = tile.ColIndex as number;

      try {
        const cKeys = client.getContentKeysByFileDataID(fileDataID);
        if (!cKeys?.length) {
          console.warn(`    Tile ${row},${col} (FDID ${fileDataID}): no content keys`);
          continue;
        }

        const result = await client.getFileByContentKey(cKeys[0].cKey, true);
        const decoded = decodeBLP(result.buffer);

        composites.push({
          input: await sharp(decoded.data, {
            raw: { width: decoded.width, height: decoded.height, channels: 4 },
          }).png().toBuffer(),
          left: col * TILE_SIZE,
          top: row * TILE_SIZE,
        });

        fetched++;
        if (fetched % 4 === 0) process.stdout.write(`    ${fetched}/${tiles.length} tiles\r`);
      } catch (err: any) {
        console.warn(`    Tile ${row},${col} (FDID ${fileDataID}): ${err.message}`);
      }
    }
    console.log(`    Fetched ${fetched}/${tiles.length} tiles`);

    if (fetched === 0) {
      console.error(`  No tiles decoded, skipping`);
      continue;
    }

    // Stitch tiles together
    console.log(`  Stitching ${totalWidth}x${totalHeight} image...`);
    const outPath = join(OUT_DIR, `${zoneKey}.png`);

    await sharp({
      create: {
        width: totalWidth,
        height: totalHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    })
      .composite(composites)
      .png({ quality: 90, compressionLevel: 6 })
      .toFile(outPath);

    console.log(`  → ${outPath}`);
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
