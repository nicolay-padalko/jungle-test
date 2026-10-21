import { Migration } from '@mikro-orm/migrations';

/** Financial tables on top of wallets (001): wager transactions and the append-only ledger. */
export class Migration202610200002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`update wallets set version = 1 where version < 1;`);
    this.addSql(`alter table wallets alter column version set default 1;`);
    this.addSql(`alter table wallets add constraint uq_wallet_id_currency unique (id, currency);`);
    this.addSql(`alter table wallets add constraint ck_wallet_currency check (currency ~ '^[A-Z]{3}$');`);
    this.addSql(`alter table wallets add constraint ck_wallet_version check (version >= 1);`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(100) not null,
        external_transaction_id varchar(255) not null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null,
        player_id varchar(255) not null,
        round_id varchar(255) not null,
        game_id varchar(255) not null,
        kind varchar(10) not null,
        status varchar(20) not null default 'PENDING',
        amount numeric(20, 2) not null,
        currency varchar(3) not null,
        reference_external_transaction_id varchar(255),
        reference_transaction_id uuid,
        failure_code varchar(100),
        response_balance numeric(20, 2),
        created_at timestamptz not null default now(),
        processed_at timestamptz,
        next_attempt_at timestamptz,
        retry_count integer not null default 0,
        constraint fk_wager_wallet_currency foreign key (wallet_id, currency)
          references wallets (id, currency) on delete restrict,
        constraint fk_wager_reference foreign key (reference_transaction_id)
          references wager_transactions (id) on delete restrict,
        constraint uq_wager_provider_external unique (provider_id, external_transaction_id),
        constraint uq_wager_provider_idempotency unique (provider_id, idempotency_key),
        constraint uq_wager_id_wallet unique (id, wallet_id),
        constraint ck_wager_kind check
          (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint ck_wager_status check
          (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint ck_wager_amount check (amount >= 0),
        constraint ck_wager_currency check (currency ~ '^[A-Z]{3}$'),
        constraint ck_wager_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint ck_wager_retry check (retry_count >= 0),
        constraint ck_wager_response_balance check
          (response_balance is null or response_balance >= 0),
        constraint ck_wager_reference_required check
          (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint ck_wager_terminal_failure check
          (status not in ('REJECTED', 'FAILED') or failure_code is not null)
      );
    `);

    this.addSql(`
      create table ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction varchar(6) not null,
        amount numeric(20, 2) not null,
        currency varchar(3) not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        created_at timestamptz not null default now(),
        constraint fk_ledger_wager_wallet foreign key (transaction_id, wallet_id)
          references wager_transactions (id, wallet_id) on delete restrict,
        constraint fk_ledger_wallet_currency foreign key (wallet_id, currency)
          references wallets (id, currency) on delete restrict,
        constraint uq_ledger_transaction_wallet unique (transaction_id, wallet_id),
        constraint ck_ledger_direction check (direction in ('DEBIT', 'CREDIT')),
        constraint ck_ledger_amount check (amount > 0),
        constraint ck_ledger_balances check
          (balance_before >= 0 and balance_after >= 0),
        constraint ck_ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or
          (direction = 'DEBIT' and balance_after = balance_before - amount)
        ),
        constraint ck_ledger_currency check (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql('create index ix_wager_wallet_created on wager_transactions (wallet_id, created_at desc, id desc);');
    this.addSql('create index ix_wager_provider_round on wager_transactions (provider_id, round_id);');
    this.addSql('create index ix_wager_pending_reference on wager_transactions (next_attempt_at, id) where status = \'PENDING_REFERENCE\';');
    this.addSql('create index ix_ledger_wallet_cursor on ledger_entries (wallet_id, created_at desc, id desc);');

    this.addSql(`
      create function prevent_ledger_mutation() returns trigger as $$
      begin
        raise exception 'ledger_entries is append-only (UPDATE/DELETE forbidden)';
      end;
      $$ language plpgsql;
    `);
    this.addSql(`
      create trigger trg_ledger_append_only
        before update or delete on ledger_entries
        for each row execute function prevent_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop trigger if exists trg_ledger_append_only on ledger_entries;');
    this.addSql('drop function if exists prevent_ledger_mutation();');
    this.addSql('drop table if exists ledger_entries;');
    this.addSql('drop table if exists wager_transactions;');
    // The wallets table itself belongs to Migration202610200001.
    this.addSql('alter table wallets drop constraint if exists ck_wallet_version;');
    this.addSql('alter table wallets drop constraint if exists ck_wallet_currency;');
    this.addSql('alter table wallets drop constraint if exists uq_wallet_id_currency;');
    this.addSql('alter table wallets alter column version set default 0;');
  }
}
