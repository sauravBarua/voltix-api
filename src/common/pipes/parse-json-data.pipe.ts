import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Parses the multipart text field `data` (a JSON string) and validates it with a Zod schema. */
export class ParseJsonDataPipe implements PipeTransform<unknown, unknown> {
  constructor(
    private readonly schema: z.ZodType,
    private readonly options: { required?: boolean } = {},
  ) {}

  transform(value: unknown): unknown {
    const required = this.options.required ?? true;
    let input: unknown = {};

    if (value === undefined || value === '') {
      if (required) throw new BadRequestException('The data field (JSON string) is required');
    } else if (typeof value !== 'string') {
      throw new BadRequestException('The data field must be a JSON string');
    } else {
      try {
        input = JSON.parse(value);
      } catch {
        throw new BadRequestException('The data field is not valid JSON');
      }
    }

    const result = this.schema.safeParse(input);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}
