import {
  BadGatewayException,
  Injectable,
  Logger,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { CloudinaryService, type UploadedImage } from './cloudinary.service';
import { detectImageType } from './image-validation';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(private readonly cloudinary: CloudinaryService) {}

  /**
   * Validates and uploads the files, then runs `work` with the uploaded assets.
   * If `work` throws (e.g. the DB write fails) the fresh assets are deleted: no orphans.
   */
  async withUploads<T>(
    files: Express.Multer.File[] | undefined,
    folder: string,
    work: (images: UploadedImage[]) => Promise<T>,
  ): Promise<T> {
    const list = files ?? [];
    this.assertValid(list);
    const uploaded = await this.uploadAll(list, folder);
    try {
      return await work(uploaded);
    } catch (error) {
      await this.deleteAssets(uploaded.map((i) => i.publicId));
      throw error;
    }
  }

  /** Best-effort deletion: a failure is logged (with the publicId) but never fails the request. */
  async deleteAssets(publicIds: string[]): Promise<void> {
    const results = await Promise.allSettled(publicIds.map((id) => this.cloudinary.destroy(id)));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.error(
          `Failed to delete Cloudinary asset ${publicIds[i]} (possible orphan): ${reason}`,
        );
      }
    });
  }

  private assertValid(files: Express.Multer.File[]) {
    for (const file of files) {
      const detected = detectImageType(file.buffer);
      if (!detected || detected !== file.mimetype) {
        throw new UnsupportedMediaTypeException(
          `${file.originalname} is not a valid jpeg, png, webp or avif image`,
        );
      }
    }
  }

  private async uploadAll(files: Express.Multer.File[], folder: string): Promise<UploadedImage[]> {
    if (files.length === 0) return [];
    const results = await Promise.allSettled(
      files.map((f) => this.cloudinary.upload(f.buffer, folder)),
    );
    const uploaded = results
      .filter((r): r is PromiseFulfilledResult<UploadedImage> => r.status === 'fulfilled')
      .map((r) => r.value);

    if (uploaded.length !== results.length) {
      // All-or-nothing: remove whatever did upload
      await this.deleteAssets(uploaded.map((i) => i.publicId));
      this.logger.error('Cloudinary upload failed');
      throw new BadGatewayException('Image upload failed, please retry');
    }
    return uploaded;
  }
}
