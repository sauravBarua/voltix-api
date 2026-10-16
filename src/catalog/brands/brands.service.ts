import { Injectable } from '@nestjs/common';
import { resolveSlug } from '../../common/utils/slugify';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateBrandDto, UpdateBrandDto } from './brands.dto';

const select = { id: true, name: true, slug: true } as const;

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.brand.findMany({ orderBy: { name: 'asc' }, select });
  }

  create(dto: CreateBrandDto) {
    return this.prisma.brand.create({
      data: { name: dto.name, slug: resolveSlug(dto.name, dto.slug) },
      select,
    });
  }

  update(id: string, dto: UpdateBrandDto) {
    return this.prisma.brand.update({
      where: { id },
      data: { name: dto.name, slug: dto.slug },
      select,
    });
  }

  async remove(id: string) {
    await this.prisma.brand.delete({ where: { id } }); // 409 if it has products
  }
}
