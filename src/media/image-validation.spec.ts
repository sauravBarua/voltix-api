import { detectImageType } from './image-validation';

describe('detectImageType', () => {
  it('detects PNG', () => {
    expect(
      detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe('image/png');
  });

  it('detects JPEG', () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('detects WebP', () => {
    const buf = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
    expect(detectImageType(buf)).toBe('image/webp');
  });

  it('rejects text and short buffers', () => {
    expect(detectImageType(Buffer.from('hello world, definitely not an image'))).toBeNull();
    expect(detectImageType(Buffer.alloc(2))).toBeNull();
  });
});
