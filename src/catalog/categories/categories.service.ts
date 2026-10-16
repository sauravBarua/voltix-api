import { BadRequestException, Injectable } from '@nestjs/common';
import { resolveSlug } from '../../common/utils/slugify';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateCategoryDto, UpdateCategoryDto } from './categories.dto';

const select = { id: true, name: true, slug: true, parentId: true } as const;

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' }, select });
  }

  async create(dto: CreateCategoryDto) {
    if (dto.parentId) await this.assertValidParent(dto.parentId);
    return this.prisma.category.create({
      data: { name: dto.name, slug: resolveSlug(dto.name, dto.slug), parentId: dto.parentId },
      select,
    });
  }

  async update(id: string, dto: UpdateCategoryDto) {
    if (dto.parentId) await this.assertValidParent(dto.parentId, id);
    return this.prisma.category.update({
      where: { id },
      data: { name: dto.name, slug: dto.slug, parentId: dto.parentId },
      select,
    });
  }

  async remove(id: string) {
    await this.prisma.category.delete({ where: { id } }); // 409 if it has products or children
  }

  /** Two levels only (root -> child), no cycles. */
  private async assertValidParent(parentId: string, selfId?: string) {
    if (parentId === selfId) throw new BadRequestException('A category cannot be its own parent');
    const parent = await this.prisma.category.findUnique({
      where: { id: parentId },
      select: { parentId: true },
    });
    if (!parent) throw new BadRequestException('parentId does not exist');
    if (parent.parentId) throw new BadRequestException('Only two category levels are supported');
    if (selfId && (await this.prisma.category.count({ where: { parentId: selfId } })) > 0) {
      throw new BadRequestException('A category that has children cannot become a child');
    }
  }
}
