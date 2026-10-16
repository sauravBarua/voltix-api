import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ParseJsonDataPipe } from './parse-json-data.pipe';

const schema = z.object({ name: z.string().min(2) });

describe('ParseJsonDataPipe', () => {
  it('parses and validates a JSON string', () => {
    expect(new ParseJsonDataPipe(schema).transform('{"name":"ab"}')).toEqual({ name: 'ab' });
  });

  it('rejects invalid JSON', () => {
    expect(() => new ParseJsonDataPipe(schema).transform('{oops')).toThrow(BadRequestException);
  });

  it('rejects schema violations', () => {
    expect(() => new ParseJsonDataPipe(schema).transform('{"name":"a"}')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a missing field when required', () => {
    expect(() => new ParseJsonDataPipe(schema).transform(undefined)).toThrow(BadRequestException);
  });

  it('treats a missing field as {} when optional', () => {
    const optional = z.object({ name: z.string().optional() });
    expect(new ParseJsonDataPipe(optional, { required: false }).transform(undefined)).toEqual({});
  });
});
