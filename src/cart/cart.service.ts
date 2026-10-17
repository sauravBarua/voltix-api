import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_CART_LINES, MAX_QTY_PER_LINE } from './cart.constants';
import type { AddCartItemDto } from './cart.dto';
import { cartSelect, toCartView } from './cart.mapper';

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string) {
    const cart = await this.prisma.cart.findUnique({ where: { userId }, select: cartSelect });
    return toCartView(cart);
  }

  async addItem(userId: string, dto: AddCartItemDto) {
    const available = await this.loadAvailable(dto.variantId);
    const cartId = await this.ensureCart(userId);

    const existing = await this.prisma.cartItem.findUnique({
      where: { cartId_variantId: { cartId, variantId: dto.variantId } },
      select: { quantity: true },
    });
    if (!existing && (await this.prisma.cartItem.count({ where: { cartId } })) >= MAX_CART_LINES) {
      throw new ConflictException(`A cart can hold at most ${MAX_CART_LINES} different items`);
    }

    const inCart = existing?.quantity ?? 0;
    this.assertQuantity(inCart + dto.quantity, available, inCart);

    await this.incrementItem(cartId, dto.variantId, dto.quantity);
    return this.get(userId);
  }

  async setQuantity(userId: string, variantId: string, quantity: number) {
    const item = await this.prisma.cartItem.findFirst({
      where: { variantId, cart: { userId } },
      select: { id: true, quantity: true },
    });
    if (!item) throw new NotFoundException('Item not in cart');

    // Reducing is always allowed (even for deactivated or short-stocked lines); increasing is validated
    if (quantity > item.quantity) {
      const available = await this.loadAvailable(variantId);
      this.assertQuantity(quantity, available, item.quantity);
    }
    await this.prisma.cartItem.update({ where: { id: item.id }, data: { quantity } });
    return this.get(userId);
  }

  async removeItem(userId: string, variantId: string) {
    const { count } = await this.prisma.cartItem.deleteMany({
      where: { variantId, cart: { userId } },
    });
    if (count === 0) throw new NotFoundException('Item not in cart');
    return this.get(userId);
  }

  async clear(userId: string) {
    await this.prisma.cartItem.deleteMany({ where: { cart: { userId } } });
    return this.get(userId);
  }

  /** Available units of a purchasable variant, or 404 if it is missing or deactivated. */
  private async loadAvailable(variantId: string): Promise<number> {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: {
        isActive: true,
        product: { select: { isActive: true } },
        inventory: { select: { onHand: true, reserved: true } },
      },
    });
    if (!variant?.isActive || !variant.product.isActive) {
      throw new NotFoundException('Variant not found or no longer available');
    }
    return Math.max(0, (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0));
  }

  private assertQuantity(requested: number, available: number, inCart: number) {
    if (requested > MAX_QTY_PER_LINE) {
      throw new BadRequestException(`At most ${MAX_QTY_PER_LINE} units of one item per order`);
    }
    if (requested > available) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: available === 0 ? 'This item is out of stock' : 'Not enough stock available',
        available,
        requested,
        inCart,
      });
    }
  }

  private async ensureCart(userId: string): Promise<string> {
    try {
      const cart = await this.prisma.cart.upsert({
        where: { userId },
        update: {},
        create: { userId },
        select: { id: true },
      });
      return cart.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost a creation race against a parallel request: the cart exists now
      const cart = await this.prisma.cart.findUniqueOrThrow({
        where: { userId },
        select: { id: true },
      });
      return cart.id;
    }
  }

  /** Atomic increment (no read-modify-write); retried once if a parallel insert wins the race. */
  private async incrementItem(cartId: string, variantId: string, quantity: number) {
    const run = () =>
      this.prisma.cartItem.upsert({
        where: { cartId_variantId: { cartId, variantId } },
        create: { cartId, variantId, quantity },
        update: { quantity: { increment: quantity } },
        select: { id: true },
      });
    try {
      await run();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await run();
    }
  }
}
