import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money/money';
import { Wallet } from '../src/domain/wallet/wallet';

const money = (amount: string) => Money.rehydrate({ amount, currency: 'BRL' });

describe('Wallet', () => {
  test('rejects a negative balance on rehydration', () => {
    expect(() => new Wallet('wallet', money('-0.01'))).toThrow('WALLET_BALANCE');
  });
  test('rejects an insufficient debit and keeps the balance', () => {
    const wallet = new Wallet('wallet', money('10.00'));
    expect(() => wallet.debit(money('10.01'))).toThrow('INSUFFICIENT_FUNDS');
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.debit(money('10.00')).balance.toString()).toBe('0.00');
  });
  test.each(['debit', 'credit'] as const)('%s validates amount and currency', method => {
    const wallet = new Wallet('wallet', money('10.00'));
    for (const value of ['0.00', '-1.00']) {
      expect(() => wallet[method](money(value))).toThrow('AMOUNT_MUST_BE_POSITIVE');
    }
    expect(() => wallet[method](Money.from({ amount: '1.00', currency: 'USD' })))
      .toThrow('CURRENCY_MISMATCH');
  });
  test('exact credit and overflow', () => {
    const wallet = new Wallet('wallet', money('999999999999999999.98'));
    expect(wallet.credit(money('0.01')).balance.toString()).toBe('999999999999999999.99');
    expect(() => wallet.credit(money('0.02'))).toThrow('MONEY_OUT_OF_RANGE');
  });
});
