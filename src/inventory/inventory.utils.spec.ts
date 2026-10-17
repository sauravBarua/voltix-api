import { escapeLike } from './inventory.utils';

describe('escapeLike', () => {
  it('escapes %, _ and backslash', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('leaves normal text alone', () => {
    expect(escapeLike('MBA13-M3')).toBe('MBA13-M3');
  });
});
