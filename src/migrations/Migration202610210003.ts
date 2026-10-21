import { Migration } from '@mikro-orm/migrations';

/** Inbox, outbox and the one-reversal-per-reference rule. */
export class Migration202610210003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(100) not null,
        message_id varchar(255) not null,
        payload_hash char(64) not null,
        transaction_id uuid null references wager_transactions(id) on delete restrict,
        received_at timestamptz not null default now(),
        processed_at timestamptz null,
        primary key (consumer_name, message_id),
        constraint ck_inbox_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint ck_inbox_processed check
          (processed_at is null or transaction_id is not null)
      );
    `);
    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null references wallets(id) on delete restrict,
        event_type varchar(100) not null,
        payload jsonb not null,
        occurred_at timestamptz not null default now(),
        attempts integer not null default 0,
        next_attempt_at timestamptz not null default now(),
        lease_owner uuid null,
        leased_until timestamptz null,
        published_at timestamptz null,
        constraint ck_outbox_attempts check (attempts >= 0),
        constraint ck_outbox_payload check (jsonb_typeof(payload) = 'object'),
        constraint ck_outbox_lease check
          ((lease_owner is null) = (leased_until is null))
      );
    `);
    this.addSql(`create index ix_outbox_due on outbox_messages
      (next_attempt_at, id) where published_at is null;`);
    this.addSql(`create index ix_inbox_transaction on inbox_messages (transaction_id);`);
    // One processed REFUND/ROLLBACK per reference, across both kinds.
    this.addSql(`create unique index uq_one_processed_reversal_per_reference
      on wager_transactions(provider_id, reference_transaction_id)
      where kind in ('REFUND','ROLLBACK') and status='PROCESSED';`);
    this.addSql(`create index ix_wager_reference_lookup
      on wager_transactions(provider_id, reference_external_transaction_id)
      where reference_external_transaction_id is not null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists ix_wager_reference_lookup;`);
    this.addSql(`drop index if exists uq_one_processed_reversal_per_reference;`);
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
  }
}
