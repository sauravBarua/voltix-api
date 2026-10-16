import { Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';
import { MediaService } from './media.service';

@Module({
  providers: [CloudinaryService, MediaService],
  exports: [MediaService],
})
export class MediaModule {}
