import { resolveSlug, slugify } from './slugify';

describe('slugify', () => {
  it('lowercases, strips accents and symbols', () => {
    expect(slugify('Écran 4K "Ultra"!')).toBe('ecran-4k-ultra');
  });

  it('keeps digits', () => {
    expect(slugify('MacBook Air 13" M3')).toBe('macbook-air-13-m3');
  });

  it('limits the length to 100', () => {
    expect(slugify('a'.repeat(150))).toHaveLength(100);
  });
});

describe('resolveSlug', () => {
  it('prefers the explicit slug', () => {
    expect(resolveSlug('Anything', 'custom-slug')).toBe('custom-slug');
  });

  it('derives the slug from the name', () => {
    expect(resolveSlug('Dell XPS 14')).toBe('dell-xps-14');
  });

  it('throws when nothing usable remains', () => {
    expect(() => resolveSlug('!!!')).toThrow(/slug/);
  });
});
