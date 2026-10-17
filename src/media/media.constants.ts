export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 5;
export const MAX_IMAGES_PER_PRODUCT = 10;

export const PRODUCT_IMAGE_FOLDER = 'voltix/products';
export const VARIANT_IMAGE_FOLDER = 'voltix/variants';
