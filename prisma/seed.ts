import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, Role } from '../src/generated/prisma/client';
import { hashPassword } from '../src/auth/password';

const seedPassword = process.env.SEED_PASSWORD ?? 'Voltix-Dev-1234!';
if (process.env.NODE_ENV === 'production' && !process.env.SEED_PASSWORD) {
  throw new Error('Set SEED_PASSWORD: the default seed password must never be used in production');
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

type SeedVariant = {
  sku: string;
  name: string;
  attributes: Prisma.InputJsonObject;
  priceMinor: number;
  stock: number;
  reorderLevel?: number;
};

type SeedProduct = {
  slug: string;
  name: string;
  brand: string;
  category: string;
  description: string;
  warrantyMonths: number;
  specs: Prisma.InputJsonObject;
  variants: SeedVariant[];
};

const categories = [
  { slug: 'laptops', name: 'Laptops' },
  { slug: 'smartphones', name: 'Smartphones' },
  { slug: 'accessories', name: 'Accessories' },
];

const brands = [
  { slug: 'apple', name: 'Apple' },
  { slug: 'samsung', name: 'Samsung' },
  { slug: 'dell', name: 'Dell' },
  { slug: 'lenovo', name: 'Lenovo' },
  { slug: 'logitech', name: 'Logitech' },
  { slug: 'anker', name: 'Anker' },
];

const users = [
  { email: 'admin@voltix.test', name: 'Admin Voltix', role: Role.ADMIN },
  { email: 'operator@voltix.test', name: 'Inventory Operator', role: Role.INVENTORY_OPERATOR },
  { email: 'customer@voltix.test', name: 'Test Customer', role: Role.CUSTOMER },
];

const products: SeedProduct[] = [
  {
    slug: 'macbook-air-13-m3',
    name: 'MacBook Air 13" M3',
    brand: 'apple',
    category: 'laptops',
    description: 'Thin and light laptop with the Apple M3 chip.',
    warrantyMonths: 24,
    specs: {
      cpu: 'Apple M3',
      gpu: '10-core GPU',
      screenSizeInch: 13.6,
      resolution: '2560x1664',
      batteryWh: 52.6,
      weightKg: 1.24,
      os: 'macOS',
    },
    variants: [
      {
        sku: 'MBA13-M3-8-256-MID',
        name: '8 GB / 256 GB / Midnight',
        attributes: { ramGb: 8, storageGb: 256, color: 'Midnight' },
        priceMinor: 119900,
        stock: 25,
      },
      {
        sku: 'MBA13-M3-16-512-SIL',
        name: '16 GB / 512 GB / Silver',
        attributes: { ramGb: 16, storageGb: 512, color: 'Silver' },
        priceMinor: 159900,
        stock: 12,
      },
    ],
  },
  {
    slug: 'dell-xps-14',
    name: 'Dell XPS 14',
    brand: 'dell',
    category: 'laptops',
    description: '14.5" premium laptop with an OLED option.',
    warrantyMonths: 24,
    specs: {
      cpu: 'Intel Core Ultra 7 155H',
      gpu: 'Intel Arc',
      screenSizeInch: 14.5,
      resolution: '2880x1800',
      batteryWh: 69.5,
      weightKg: 1.7,
      os: 'Windows 11',
    },
    variants: [
      {
        sku: 'XPS14-U7-16-512-GRA',
        name: '16 GB / 512 GB / Graphite',
        attributes: { ramGb: 16, storageGb: 512, color: 'Graphite' },
        priceMinor: 189900,
        stock: 8,
      },
      {
        sku: 'XPS14-U7-32-1024-GRA',
        name: '32 GB / 1 TB / Graphite',
        attributes: { ramGb: 32, storageGb: 1024, color: 'Graphite' },
        priceMinor: 239900,
        stock: 4, // below reorder level: shows up in low-stock
      },
    ],
  },
  {
    slug: 'thinkpad-x1-carbon-gen12',
    name: 'Lenovo ThinkPad X1 Carbon Gen 12',
    brand: 'lenovo',
    category: 'laptops',
    description: 'Business ultrabook, light and durable.',
    warrantyMonths: 36,
    specs: {
      cpu: 'Intel Core Ultra 7 165U',
      gpu: 'Intel Graphics',
      screenSizeInch: 14,
      resolution: '1920x1200',
      batteryWh: 57,
      weightKg: 1.09,
      os: 'Windows 11 Pro',
    },
    variants: [
      {
        sku: 'X1C12-U7-16-512-BLK',
        name: '16 GB / 512 GB / Black',
        attributes: { ramGb: 16, storageGb: 512, color: 'Black' },
        priceMinor: 179900,
        stock: 10,
      },
    ],
  },
  {
    slug: 'iphone-16-pro',
    name: 'iPhone 16 Pro',
    brand: 'apple',
    category: 'smartphones',
    description: 'Titanium smartphone with the A18 Pro chip.',
    warrantyMonths: 24,
    specs: {
      chipset: 'A18 Pro',
      screenSizeInch: 6.3,
      batteryMah: 3582,
      rearCameraMp: 48,
      os: 'iOS',
      fiveG: true,
    },
    variants: [
      {
        sku: 'IP16P-256-BLK',
        name: '256 GB / Black Titanium',
        attributes: { storageGb: 256, color: 'Black Titanium' },
        priceMinor: 129900,
        stock: 3, // hot variant, low stock
      },
      {
        sku: 'IP16P-512-NAT',
        name: '512 GB / Natural Titanium',
        attributes: { storageGb: 512, color: 'Natural Titanium' },
        priceMinor: 149900,
        stock: 15,
      },
    ],
  },
  {
    slug: 'galaxy-s24-ultra',
    name: 'Samsung Galaxy S24 Ultra',
    brand: 'samsung',
    category: 'smartphones',
    description: 'Flagship Android smartphone with S Pen.',
    warrantyMonths: 24,
    specs: {
      chipset: 'Snapdragon 8 Gen 3 for Galaxy',
      screenSizeInch: 6.8,
      batteryMah: 5000,
      rearCameraMp: 200,
      os: 'Android',
      fiveG: true,
    },
    variants: [
      {
        sku: 'S24U-256-GRY',
        name: '256 GB / Titanium Gray',
        attributes: { storageGb: 256, color: 'Titanium Gray' },
        priceMinor: 129900,
        stock: 20,
      },
      {
        sku: 'S24U-1024-BLK',
        name: '1 TB / Titanium Black',
        attributes: { storageGb: 1024, color: 'Titanium Black' },
        priceMinor: 179900,
        stock: 0, // out of stock
      },
    ],
  },
  {
    slug: 'logitech-mx-master-3s',
    name: 'Logitech MX Master 3S',
    brand: 'logitech',
    category: 'accessories',
    description: 'Wireless performance mouse.',
    warrantyMonths: 24,
    specs: { type: 'mouse', connectivity: ['Bluetooth', 'USB receiver'], dpiMax: 8000 },
    variants: [
      {
        sku: 'LOGI-MXM3S-GRA',
        name: 'Graphite',
        attributes: { color: 'Graphite' },
        priceMinor: 10990,
        stock: 40,
        reorderLevel: 10,
      },
    ],
  },
  {
    slug: 'anker-735-gan-charger-65w',
    name: 'Anker 735 Charger 65W',
    brand: 'anker',
    category: 'accessories',
    description: 'Compact GaN USB-C charger.',
    warrantyMonths: 18,
    specs: { type: 'charger', powerW: 65, ports: 3 },
    variants: [
      {
        sku: 'ANKR-735-65W-BLK',
        name: 'Black',
        attributes: { color: 'Black' },
        priceMinor: 4990,
        stock: 60,
        reorderLevel: 15,
      },
    ],
  },
];

async function main() {
  for (const c of categories) {
    await prisma.category.upsert({ where: { slug: c.slug }, update: { name: c.name }, create: c });
  }
  for (const b of brands) {
    await prisma.brand.upsert({ where: { slug: b.slug }, update: { name: b.name }, create: b });
  }
  const passwordHash = await hashPassword(seedPassword);
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { ...u, passwordHash },
    });
    // Users created before Phase 13 have no password yet: give them one, never overwrite an existing one
    await prisma.user.updateMany({
      where: { email: u.email, passwordHash: null },
      data: { passwordHash },
    });
  }

  for (const p of products) {
    const product = await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        slug: p.slug,
        name: p.name,
        description: p.description,
        warrantyMonths: p.warrantyMonths,
        specs: p.specs,
        brand: { connect: { slug: p.brand } },
        category: { connect: { slug: p.category } },
      },
    });

    for (const v of p.variants) {
      const variant = await prisma.productVariant.upsert({
        where: { sku: v.sku },
        update: {},
        create: {
          productId: product.id,
          sku: v.sku,
          name: v.name,
          attributes: v.attributes,
          priceMinor: v.priceMinor,
        },
      });

      // Create stock + ledger entry together, and only once (re-running must not reset stock)
      const existing = await prisma.inventoryItem.findUnique({ where: { variantId: variant.id } });
      if (!existing) {
        await prisma.$transaction([
          prisma.inventoryItem.create({
            data: { variantId: variant.id, onHand: v.stock, reorderLevel: v.reorderLevel ?? 5 },
          }),
          prisma.inventoryMovement.create({
            data: {
              variantId: variant.id,
              type: 'STOCK_IN',
              deltaOnHand: v.stock,
              deltaReserved: 0,
              reason: 'Initial seed stock',
              referenceType: 'SEED',
              referenceId: 'initial',
            },
          }),
        ]);
      }
    }
  }

  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
