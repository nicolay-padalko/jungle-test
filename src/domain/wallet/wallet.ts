import { Money } from '../money/money';

export class InsufficientFundsError extends Error {
  constructor() { super('INSUFFICIENT_FUNDS'); }
}

/** Immutable: concurrent movements must be serialized by a database lock. */
export class Wallet {
  constructor(public readonly id: string, public readonly balance: Money) {
    if (balance.isNegative()) throw new Error('WALLET_BALANCE_MUST_BE_NONNEGATIVE');
  }

  debit(amount: Money): Wallet {
    this.assertMovement(amount);
    if (this.balance.isLessThan(amount)) throw new InsufficientFundsError();
    return new Wallet(this.id, this.balance.subtract(amount));
  }

  credit(amount: Money): Wallet {
    this.assertMovement(amount);
    return new Wallet(this.id, this.balance.add(amount));
  }

  private assertMovement(amount: Money): void {
    if (amount.currency !== this.balance.currency) throw new Error('CURRENCY_MISMATCH');
    if (!amount.isPositive()) throw new Error('AMOUNT_MUST_BE_POSITIVE');
  }
}
