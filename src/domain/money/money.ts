import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const DECIMAL_INPUT = /^-?(?:0|[1-9]\d*)\.\d{2}$/;
export const SUPPORTED_CURRENCIES = Object.freeze(['BRL', 'USD', 'EUR'] as const);
// numeric(20,2) holds 18 integer digits; one extra digit of precision lets
// add/subtract detect overflow before any rounding happens.
const FinancialDecimal = Decimal.clone({
  precision: 21, rounding: Decimal.ROUND_HALF_EVEN, minE: -2, maxE: 18,
});
const MAX_AMOUNT = new FinancialDecimal('999999999999999999.99');

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** External contracts: negative amounts are rejected. */
  static from(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  /** Internal values (e.g. reconciliation differences) may be negative. */
  static rehydrate(props: MoneyProps): Money {
    return Money.parse(props, true);
  }

  private static parse(props: MoneyProps, allowNegative: boolean): Money {
    if (!props || typeof props.amount !== 'string' || !DECIMAL_INPUT.test(props.amount)) {
      throw new Error('INVALID_MONEY_AMOUNT');
    }
    if (!SUPPORTED_CURRENCIES.some(currency => currency === props.currency)) {
      throw new Error('UNSUPPORTED_CURRENCY');
    }
    const value = new FinancialDecimal(props.amount);
    Money.assertRange(value);
    if (!allowNegative && value.isNegative()) {
      throw new Error('NEGATIVE_AMOUNT_NOT_ALLOWED');
    }
    return new Money(value, props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    const value = this.value.plus(other.value);
    Money.assertRange(value);
    return new Money(value, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const value = this.value.minus(other.value);
    Money.assertRange(value);
    return new Money(value, this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.greaterThan(0); }
  isNegative(): boolean { return this.value.isNegative(); }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new Error('CURRENCY_MISMATCH');
  }

  private static assertRange(value: Decimal): void {
    if (!value.isFinite() || value.abs().greaterThan(MAX_AMOUNT)) {
      throw new Error('MONEY_OUT_OF_RANGE');
    }
  }
}
