import { describe, expect, it } from 'bun:test';
import latin from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff' with {
  type: 'file',
};
import japanese from '@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-400-normal.woff' with {
  type: 'file',
};
import * as fontkit from 'fontkit';
import { woffToSfnt } from '../../../src/lib/pdf/woff';

const read = async (path: string) => Buffer.from(await Bun.file(path).arrayBuffer());
const face = (bytes: Buffer) => fontkit.create(bytes) as fontkit.Font;

describe('woffToSfnt (SC-1593)', () => {
  it.each([
    ['latin', latin],
    ['japanese', japanese],
  ])('%s: the unwrapped face is the face the WOFF carries', async (_, path) => {
    const woff = await read(path);
    const sfnt = woffToSfnt(woff);
    expect(sfnt.toString('latin1', 0, 4)).not.toBe('wOFF');
    const before = face(woff);
    const after = face(sfnt);
    expect(after.numGlyphs).toBe(before.numGlyphs);
    expect(after.characterSet).toEqual(before.characterSet);
    const text = path === japanese ? '合計 1,234' : 'Total 1,234';
    expect(after.layout(text).glyphs.map((g) => g.id)).toEqual(
      before.layout(text).glyphs.map((g) => g.id)
    );
  });

  it('control: bytes that are not WOFF come back unchanged', async () => {
    const sfnt = woffToSfnt(await read(latin));
    expect(woffToSfnt(sfnt)).toBe(sfnt);
  });
});
