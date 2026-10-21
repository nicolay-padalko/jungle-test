import { Migration } from '@mikro-orm/migrations';

export class Migration202610200001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table "wallets" (
      "id" uuid not null,
      "player_id" varchar(255) not null,
      "currency" varchar(3) not null,
      "balance" numeric(20,2) not null default 0,
      "version" integer not null default 0,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      constraint "wallets_pkey" primary key ("id"),
      constraint "wallets_player_currency_unique" unique ("player_id", "currency"),
      constraint "wallets_nonnegative_balance" check ("balance" >= 0),
      constraint "wallets_nonnegative_version" check ("version" >= 0)
    );`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "wallets";');
  }
}
