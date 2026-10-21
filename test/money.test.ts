import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money/money';
import Decimal from 'decimal.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test.each(['BRL', 'USD', 'EUR'])('accepts supported currency %s', currency => {
    expect(Money.zero(currency).currency).toBe(currency);
  });
  test.each(['XYZ', 'JPY', 'brl', '', 'BR'])('rejects unsupported currency %s', currency => {
    expect(() => Money.zero(currency)).toThrow('UNSUPPORTED_CURRENCY');
  });
  test('keeps cents at the limit and rejects overflow in both directions', () => {
    const max = brl('999999999999999999.99');
    expect(max.subtract(brl('0.01')).toString()).toBe('999999999999999999.98');
    expect(() => max.add(brl('0.01'))).toThrow('MONEY_OUT_OF_RANGE');
    expect(() => max.negate().subtract(brl('0.01'))).toThrow('MONEY_OUT_OF_RANGE');
    expect(() => brl('1000000000000000000.00')).toThrow('MONEY_OUT_OF_RANGE');
    expect(() => brl('999999999999999999999999999.99')).toThrow('MONEY_OUT_OF_RANGE');
  });
  test('global Decimal configuration does not affect Money', () => {
    const precision = Decimal.precision;
    const rounding = Decimal.rounding;
    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN });
      expect(brl('999999999999999999.98').add(brl('0.01')).toString())
        .toBe('999999999999999999.99');
    } finally { Decimal.set({ precision, rounding }); }
  });
  test('zero is neither positive nor negative', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
  });
  test.each(['add', 'subtract', 'equals', 'isLessThan'] as const)('%s rejects a different currency', method => {
    expect(() => brl('1.00')[method](Money.from({ amount: '1.00', currency: 'USD' }))).toThrow('CURRENCY_MISMATCH');
  });
  test('adds decimals exactly', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });
  test('does not mutate the original instance', () => {
    const original = brl('10.00');
    const result = original.subtract(brl('3.50'));
    expect(original.toString()).toBe('10.00');
    expect(result.toString()).toBe('6.50');
  });
  test('serializes as a two-decimal string', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });
  test.each(['NaN', 'Infinity', '1e3', '', '1.234', '1', '01.00'])(
    'rejects invalid input %s', amount => {
      expect(() => brl(amount)).toThrow('INVALID_MONEY_AMOUNT');
    },
  );
  test('rejects negative input on external contracts', () => {
    expect(() => brl('-1.00')).toThrow('NEGATIVE_AMOUNT_NOT_ALLOWED');
  });
  test('allows negative internal results', () => {
    expect(brl('1.00').subtract(brl('2.00')).toString()).toBe('-1.00');
    expect(Money.rehydrate({ amount: '-1.00', currency: 'BRL' }).isNegative()).toBe(true);
  });
});
