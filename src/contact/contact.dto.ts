import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const contactSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  subject: z.string().trim().min(3).max(150),
  message: z.string().trim().min(10).max(5000),
});

export class ContactDto extends createZodDto(contactSchema) {}
