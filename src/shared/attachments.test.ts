import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { attachKey, delivery, displayName, savedName, sniff } from './attachments.ts';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('attachments', () => {
  test('a file is judged by its bytes', () => {
    assert.equal(sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))?.mime, 'image/png');
    assert.equal(sniff(bytes(0xff, 0xd8, 0xff, 0xe0))?.ext, 'jpg');
    assert.equal(sniff(text('GIF89a....'))?.mime, 'image/gif');
    assert.equal(sniff(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))?.mime, 'image/webp');
    assert.equal(sniff(text('%PDF-1.7\n'))?.kind, 'pdf');
    assert.equal(sniff(text('plain notes, ünïcode too\n'))?.kind, 'text');
    assert.equal(sniff(bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70)), null, 'HEIC and other binaries are refused');
    assert.equal(sniff(bytes(0xc3, 0x28)), null, 'not UTF-8');
    assert.equal(sniff(bytes()), null, 'empty');
  });

  test('saved names say what the bytes are, so an agent going by the extension is not misled', () => {
    const png = { kind: 'image', mime: 'image/png', ext: 'png' } as const;
    const plain = { kind: 'text', mime: 'text/plain', ext: '' } as const;
    assert.equal(savedName('Screen Shot 2026-10-07 at 9.41.12 AM.png', png), 'Screen-Shot-2026-10-07-at-9.41.12-AM.png');
    assert.equal(savedName('photo.heic', png), 'photo.png', 'the bytes win over the name');
    assert.equal(savedName('../../etc/passwd', plain), 'etc-passwd');
    assert.equal(savedName('notes.png', plain), 'notes.png.txt', 'text named like an image is not read as one');
    assert.equal(savedName('…', png), 'image.png');
    assert.equal(savedName('.env', plain), 'env');
    assert.equal(displayName('/Users/someone/Desktop/a\u0007b.txt'), 'ab.txt');
  });

  test('each agent is typed what it takes', () => {
    const files = [
      { path: '/data/attachments/s/1-shot.png', kind: 'image' as const },
      { path: '/data/attachments/s/2-notes.md', kind: 'text' as const },
      { path: '/data/Wanigan 2/attachments/s/3-it’s.png', kind: 'image' as const },
    ];
    assert.deepEqual(delivery('claude', 'Look at these', files), {
      images: ['/data/attachments/s/1-shot.png\n/data/Wanigan 2/attachments/s/3-it’s.png'],
      waitForImages: 2,
      text: 'Look at these\n\nAttached file: /data/attachments/s/2-notes.md',
    });
    assert.deepEqual(delivery('codex', '', files), {
      images: [`'/data/attachments/s/1-shot.png'`, `'/data/Wanigan 2/attachments/s/3-it’s.png'`],
      waitForImages: 0,
      text: 'Attached file: /data/attachments/s/2-notes.md',
    });
    assert.deepEqual(delivery('codex', 'x', [{ path: "/a/it's.png", kind: 'image' }]).images, [`'/a/it'\\''s.png'`]);
    assert.deepEqual(delivery('claude', 'just words', []), { images: [], waitForImages: 0, text: 'just words' });
    assert.equal(attachKey({ chat: null }), 'chat:*');
    assert.equal(attachKey({ session: 'abc' }), 'session:abc');
  });
});
