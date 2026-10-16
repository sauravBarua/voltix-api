import { z } from 'zod';

const laptopSpecs = z.strictObject({
  cpu: z.string().min(1),
  gpu: z.string().min(1).optional(),
  screenSizeInch: z.number().positive().max(30),
  resolution: z.string().min(1).optional(),
  batteryWh: z.number().positive().optional(),
  weightKg: z.number().positive().optional(),
  os: z.string().min(1),
});

const smartphoneSpecs = z.strictObject({
  chipset: z.string().min(1),
  screenSizeInch: z.number().positive().max(15),
  batteryMah: z.number().int().positive(),
  rearCameraMp: z.number().positive().optional(),
  os: z.string().min(1),
  fiveG: z.boolean().optional(),
});

// Accessories are heterogeneous: only a "type" is required
const accessorySpecs = z.looseObject({ type: z.string().min(1) });

const genericSpecs = z.record(z.string(), z.unknown());

const byCategorySlug: Record<string, z.ZodType> = {
  laptops: laptopSpecs,
  smartphones: smartphoneSpecs,
  accessories: accessorySpecs,
};

/** Tries the category slug, then its parent's slug, then falls back to a generic object. */
export function getSpecsSchema(...slugs: (string | null | undefined)[]): z.ZodType {
  for (const slug of slugs) {
    if (slug && Object.hasOwn(byCategorySlug, slug)) return byCategorySlug[slug];
  }
  return genericSpecs;
}
