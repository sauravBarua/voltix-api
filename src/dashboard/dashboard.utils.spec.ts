import { BadRequestException } from '@nestjs/common';
import {
  averageOrderValue,
  isValidTimeZone,
  previousRange,
  resolveRange,
  sharePercent,
  toCsv,
} from './dashboard.utils';

const now = new Date('2026-10-20T10:00:30Z');

describe('resolveRange', () => {
  it('defaults to the last 30 days ending at the next full minute', () => {
    const r = resolveRange({}, now);
    expect(r.to.toISOString()).toBe('2026-10-20T10:01:00.000Z');
    expect(r.from.toISOString()).toBe('2026-09-20T10:01:00.000Z');
    expect(r.tz).toBe('Europe/Paris');
  });

  it('fills in the missing side', () => {
    expect(resolveRange({ to: '2001-03-31T00:00:00Z' }, now).from.toISOString()).toBe(
      '2001-03-01T00:00:00.000Z',
    );
    expect(resolveRange({ from: '2026-10-01T00:00:00Z' }, now).to.toISOString()).toBe(
      '2026-10-20T10:01:00.000Z',
    );
  });

  it('refuses reversed, empty and oversized ranges', () => {
    expect(() =>
      resolveRange({ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, now),
    ).toThrow(BadRequestException);
    expect(() =>
      resolveRange({ from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, now),
    ).toThrow(BadRequestException);
    expect(() =>
      resolveRange({ from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, now),
    ).toThrow(/366/);
  });
});

describe('previousRange', () => {
  it('ends where the current range starts and has the same length', () => {
    const r = previousRange(
      resolveRange({ from: '2001-03-01T00:00:00Z', to: '2001-04-01T00:00:00Z', tz: 'UTC' }),
    );
    expect(r.from.toISOString()).toBe('2001-01-29T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2001-03-01T00:00:00.000Z');
    expect(r.tz).toBe('UTC');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects nonsense', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Phobos')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('averageOrderValue and sharePercent', () => {
  it('rounds and never divides by zero', () => {
    expect(averageOrderValue(8470, 3)).toBe(2823);
    expect(averageOrderValue(0, 0)).toBe(0);
    expect(sharePercent(3000, 5500)).toBe(54.5);
    expect(sharePercent(1, 0)).toBe(0);
  });
});

describe('toCsv', () => {
  it('writes a header, numbers, and nulls', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x', 1],
          [null, 2],
        ],
      ),
    ).toBe('a,b\r\nx,1\r\n,2\r\n');
  });

  it('quotes commas, quotes and newlines', () => {
    expect(toCsv(['t'], [['a,b'], ['say "hi"'], ['l1\nl2']])).toBe(
      't\r\n"a,b"\r\n"say ""hi"""\r\n"l1\nl2"\r\n',
    );
  });

  it('neutralises spreadsheet formulas in text but keeps negative numbers', () => {
    expect(toCsv(['t'], [['=SUM(A1)'], ['+1'], ['@x'], [-5]])).toBe(
      "t\r\n'=SUM(A1)\r\n'+1\r\n'@x\r\n-5\r\n",
    );
  });
});
