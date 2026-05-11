import { decimalColumnTransformer } from '../../src/common/decimal-column.transformer';

describe('decimalColumnTransformer', () => {
  it('from returns null for null DB value', () => {
    expect(decimalColumnTransformer.from(null)).toBeNull();
  });

  it('from parses numeric string from DB', () => {
    expect(decimalColumnTransformer.from('12.5')).toBe(12.5);
  });

  it('to passes through number or string', () => {
    expect(decimalColumnTransformer.to(3)).toBe(3);
    expect(decimalColumnTransformer.to('4')).toBe('4');
  });
});
