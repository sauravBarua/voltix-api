import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { FilesInterceptor } from '@nestjs/platform-express';
import type { ApiBodyOptions } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { ALLOWED_IMAGE_MIME, MAX_FILES_PER_REQUEST, MAX_IMAGE_BYTES } from './media.constants';

type UploadOptions = NonNullable<Parameters<typeof FilesInterceptor>[2]>;

// Memory storage: buffers go straight to Cloudinary, nothing touches the disk.
// Size/count violations become 413/400 automatically via Nest's multer error mapping.
export const imageUploadOptions: UploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_FILES_PER_REQUEST, fieldSize: 100 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_IMAGE_MIME as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new UnsupportedMediaTypeException('Only jpeg, png and webp images are allowed'), false);
    }
  },
};

/** Swagger body description for multipart endpoints (the Zod DTO cannot describe files). */
export function multipartBody(o: {
  field: 'image' | 'images';
  dataExample: string;
  dataRequired: boolean;
}): ApiBodyOptions {
  const file = { type: 'string', format: 'binary' } as const;
  return {
    schema: {
      type: 'object',
      required: o.dataRequired ? ['data'] : [],
      properties: {
        data: {
          type: 'string',
          description: 'JSON string with the entity fields',
          example: o.dataExample,
        },
        [o.field]: o.field === 'images' ? { type: 'array', items: file } : file,
      },
    },
  };
}
