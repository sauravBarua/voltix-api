import { BadRequestException } from '@nestjs/common';

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/, '');
}

/** Explicit slug wins; otherwise derive it from the name. */
export function resolveSlug(name: string, slug?: string): string {
  const result = slug ?? slugify(name);
  if (result.length < 2) {
    throw new BadRequestException('Cannot derive a valid slug from the name, please provide one');
  }
  return result;
}
