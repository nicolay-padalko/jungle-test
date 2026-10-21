import { Migration } from '@mikro-orm/migrations';

/** Restricts currencies to the ones Money supports. */
export class Migration202610210001 extends Migration {
  override async up(): Promise<void> {
    for (const [table, constraint] of [
      ['wallets', 'ck_wallet_currency'],
      ['wager_transactions', 'ck_wager_currency'],
      ['ledger_entries', 'ck_ledger_currency'],
    ]) {
      this.addSql(`alter table ${table} drop constraint ${constraint};`);
      this.addSql(`alter table ${table} add constraint ${constraint}
        check (currency in ('BRL', 'USD', 'EUR'));`);
    }
  }

  override async down(): Promise<void> {
    for (const [table, constraint] of [
      ['wallets', 'ck_wallet_currency'],
      ['wager_transactions', 'ck_wager_currency'],
      ['ledger_entries', 'ck_ledger_currency'],
    ]) {
      this.addSql(`alter table ${table} drop constraint ${constraint};`);
      this.addSql(`alter table ${table} add constraint ${constraint}
        check (currency ~ '^[A-Z]{3}$');`);
    }
  }
}
