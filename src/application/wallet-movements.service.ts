import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../domain/money/money';

type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
type Direction = 'DEBIT' | 'CREDIT';
type Status = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

type WalletRow = { id: string; player_id: string; currency: string; balance: string; version: number };
type TransactionRow = {
  id: string; provider_id: string; external_transaction_id: string; payload_hash: string;
  wallet_id: string; player_id: string; round_id: string; game_id: string;
  kind: Kind | 'OPENING'; status: Status; amount: string; currency: string;
  reference_external_transaction_id: string | null; reference_transaction_id: string | null;
  response_balance: string | null; failure_code: string | null; retry_count: number;
};

export type MovementInput = {
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  roundId: string;
  gameId: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
};

export type MovementResult = {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  balance: string;
  failureCode: string | null;
};

export type DeliveryContext = {
  messageId: string;
  consumerName?: string;
};

/** Single use case shared by HTTP and SQS. */
@Injectable()
export class WalletMovementsService {
  constructor(private readonly em: EntityManager) {}

  debit(input: MovementInput, ctx?: DeliveryContext) { return this.process('BET', input, ctx); }
  credit(input: MovementInput, ctx?: DeliveryContext) { return this.process('WIN', input, ctx); }
  loss(input: MovementInput, ctx?: DeliveryContext) { return this.process('LOSS', input, ctx); }
  refund(input: MovementInput, ctx?: DeliveryContext) { return this.process('REFUND', input, ctx); }
  rollback(input: MovementInput, ctx?: DeliveryContext) { return this.process('ROLLBACK', input, ctx); }

  async process(kind: Kind, input: MovementInput, ctx?: DeliveryContext): Promise<MovementResult> {
    const amount = Money.from({ amount: input.amount, currency: input.currency });
    if (kind !== 'LOSS' && !amount.isPositive()) throw new Error('AMOUNT_MUST_BE_POSITIVE');
    if (['walletId','providerId','externalTransactionId','idempotencyKey','roundId','gameId']
      .some(k => !input[k as keyof MovementInput])) throw new Error('MISSING_REQUIRED_FIELD');
    if ((kind === 'REFUND' || kind === 'ROLLBACK') && !input.referenceExternalTransactionId)
      throw new Error('REFERENCE_REQUIRED');
    if (ctx && (!ctx.messageId || !ctx.consumerName)) throw new Error('INVALID_DELIVERY_CONTEXT');

    // messageId and idempotencyKey identify the delivery, not the business payload, so they stay out of the hash.
    const hash = createHash('sha256').update(JSON.stringify({
      providerId: input.providerId, externalTransactionId: input.externalTransactionId,
      walletId: input.walletId, roundId: input.roundId, gameId: input.gameId,
      kind, amount: amount.toString(), currency: input.currency,
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    })).digest('hex');

    return this.em.transactional(async tx => {
      if (ctx) {
        // A concurrent duplicate delivery waits on the primary key here, then takes the replay path.
        const inboxInserted = await tx.execute<Array<{ message_id: string }>>(`
          insert into inbox_messages (consumer_name, message_id, payload_hash)
          values (?, ?, ?) on conflict do nothing returning message_id
        `, [ctx.consumerName, ctx.messageId, hash]);
        if (!inboxInserted.length) {
          const previous = await tx.execute<Array<{ payload_hash: string; processed_at: Date | null; transaction_id: string | null }>>(`
            select payload_hash, processed_at, transaction_id from inbox_messages
            where consumer_name=? and message_id=? for update
          `, [ctx.consumerName, ctx.messageId]);
          if (previous.length !== 1 || previous[0].payload_hash !== hash) throw new Error('INBOX_MESSAGE_CONFLICT');
          if (!previous[0].processed_at || !previous[0].transaction_id) throw new Error('INBOX_NOT_FINALIZED');
          return this.resultById(tx, previous[0].transaction_id);
        }
      }

      const id = randomUUID();
      const inserted = await tx.execute<Array<{ id: string }>>(`
        insert into wager_transactions
          (id,provider_id,external_transaction_id,idempotency_key,payload_hash,
           wallet_id,player_id,round_id,game_id,kind,status,amount,currency,
           reference_external_transaction_id)
        select ?,?,?,?,?,w.id,w.player_id,?, ?,?,'PENDING',?::numeric,?,?
        from wallets w where w.id=? and w.currency=?
        on conflict do nothing returning id
      `, [id, input.providerId, input.externalTransactionId, input.idempotencyKey,
        hash, input.roundId, input.gameId, kind, amount.toString(), input.currency,
        input.referenceExternalTransactionId ?? null, input.walletId, input.currency]);

      let result: MovementResult;
      if (!inserted.length) {
        const existing = await tx.execute<TransactionRow[]>(`
          select *, amount::text, response_balance::text from wager_transactions
          where provider_id=? and (idempotency_key=? or external_transaction_id=?)
          for update
        `, [input.providerId, input.idempotencyKey, input.externalTransactionId]);
        if (!existing.length) throw new Error('WALLET_NOT_FOUND_OR_CURRENCY_MISMATCH');
        if (existing.length !== 1 || existing[0].payload_hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
        result = this.snapshot(existing[0]);
      } else {
        // Locked per wallet: operations on other wallets run in parallel.
        const wallet = await this.lockWallet(tx, input.walletId);
        if (wallet.currency !== input.currency) throw new Error('CURRENCY_MISMATCH');
        const current = await this.loadTransaction(tx, id);
        result = await this.apply(tx, current, wallet, true);
      }

      if (ctx) {
        await tx.execute(`update inbox_messages set processed_at=now(), transaction_id=?
          where consumer_name=? and message_id=?`, [result.transactionId, ctx.consumerName, ctx.messageId]);
      }
      return result;
    });
  }

  /** Safe to run from several instances: each row is claimed with SKIP LOCKED. */
  async retryPendingReferences(limit = 20): Promise<number> {
    const candidates = await this.em.execute<Array<{ id: string }>>(`
      select id from wager_transactions
      where status='PENDING_REFERENCE' and next_attempt_at <= now()
      order by next_attempt_at, id limit ?
    `, [limit]);
    let touched = 0;
    for (const { id } of candidates) {
      const handled = await this.em.transactional(async tx => {
        const rows = await tx.execute<TransactionRow[]>(`
          select *, amount::text, response_balance::text from wager_transactions
          where id=? and status='PENDING_REFERENCE' and next_attempt_at<=now()
          for update skip locked
        `, [id]);
        if (!rows.length) return false;
        const wallet = await this.lockWallet(tx, rows[0].wallet_id);
        await this.apply(tx, rows[0], wallet, false);
        return true;
      });
      if (handled) touched++;
    }
    return touched;
  }

  private async apply(tx: EntityManager, row: TransactionRow, wallet: WalletRow, first: boolean): Promise<MovementResult> {
    const before = Money.from({ amount: wallet.balance, currency: wallet.currency });
    const amount = Money.from({ amount: row.amount, currency: row.currency });
    let direction: Direction | null = row.kind === 'BET' ? 'DEBIT' : row.kind === 'WIN' ? 'CREDIT' : null;
    let referenceId: string | null = null;

    if (row.kind === 'REFUND' || row.kind === 'ROLLBACK') {
      const refs = await tx.execute<TransactionRow[]>(`
        select *, amount::text, response_balance::text from wager_transactions
        where provider_id=? and external_transaction_id=?
      `, [row.provider_id, row.reference_external_transaction_id]);
      if (!refs.length || ['PENDING', 'PENDING_REFERENCE'].includes(refs[0].status)) {
        if (!first && row.retry_count + 1 >= 6) {
          return this.reject(tx, row, before, 'REFERENCE_NOT_FOUND');
        }
        const delay = Math.min(60, 2 ** Math.min(row.retry_count + 1, 6));
        await tx.execute(`update wager_transactions set status='PENDING_REFERENCE',
          retry_count=retry_count+1, next_attempt_at=now()+(?::integer * interval '1 second'),
          response_balance=?::numeric where id=?`, [delay, before.toString(), row.id]);
        if (first) await this.event(tx, 'WagerTransactionPendingReference', row, {
          referenceExternalTransactionId: row.reference_external_transaction_id,
        });
        return { transactionId: row.id, status: 'PENDING_REFERENCE', balance: before.toString(), failureCode: null };
      }
      const ref = refs[0];
      if (ref.status !== 'PROCESSED') return this.reject(tx, row, before, 'REFERENCE_NOT_PROCESSED');
      if (ref.wallet_id !== row.wallet_id || ref.player_id !== row.player_id ||
          ref.currency !== row.currency || ref.round_id !== row.round_id)
        return this.reject(tx, row, before, 'REFERENCE_CONTEXT_MISMATCH');
      if (ref.amount !== amount.toString()) return this.reject(tx, row, before, 'REFERENCE_AMOUNT_MISMATCH');
      if (row.kind === 'REFUND' && ref.kind !== 'BET')
        return this.reject(tx, row, before, 'REFUND_REQUIRES_BET');
      if (row.kind === 'ROLLBACK' && !['BET', 'WIN', 'REFUND'].includes(ref.kind))
        return this.reject(tx, row, before, 'INVALID_ROLLBACK_TARGET');

      // One processed reversal per reference across REFUND and ROLLBACK (also a unique index).
      const alreadyReversed = await tx.execute<Array<{ id: string }>>(`
        select id from wager_transactions where provider_id=? and reference_transaction_id=?
          and kind in ('REFUND','ROLLBACK') and status='PROCESSED' limit 1
      `, [row.provider_id, ref.id]);
      if (alreadyReversed.length) return this.reject(tx, row, before, 'REFERENCE_ALREADY_REVERSED');
      referenceId = ref.id;
      direction = row.kind === 'REFUND' || ref.kind === 'BET' ? 'CREDIT' : 'DEBIT';
    }

    const after = direction === 'DEBIT' ? before.subtract(amount)
      : direction === 'CREDIT' ? before.add(amount) : before;
    if (after.isNegative()) {
      return this.reject(tx, row, before, row.kind === 'BET' ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_INSUFFICIENT_FUNDS');
    }

    if (direction) {
      await tx.execute(`update wallets set balance=?::numeric, version=version+1,
        updated_at=now() where id=?`, [after.toString(), wallet.id]);
      await tx.execute(`insert into ledger_entries
        (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
        values (?,?,?,?,?::numeric,?,?::numeric,?::numeric)`,
        [randomUUID(), wallet.id, row.id, direction, amount.toString(), row.currency,
         before.toString(), after.toString()]);
    }
    await tx.execute(`update wager_transactions set status='PROCESSED',
      reference_transaction_id=?, response_balance=?::numeric, failure_code=null,
      processed_at=now(), next_attempt_at=null where id=?`, [referenceId, after.toString(), row.id]);

    await this.event(tx, 'WagerTransactionProcessed', row, { kind: row.kind, status: 'PROCESSED' });
    if (direction) await this.event(tx, 'WalletBalanceChanged', row, {
      transactionId: row.id, direction, money: amount.toJSON(),
      balanceBefore: before.toJSON(), balanceAfter: after.toJSON(), walletVersion: wallet.version + 1,
    });
    return { transactionId: row.id, status: 'PROCESSED', balance: after.toString(), failureCode: null };
  }

  private async reject(tx: EntityManager, row: TransactionRow, before: Money, code: string): Promise<MovementResult> {
    await tx.execute(`update wager_transactions set status='REJECTED', failure_code=?,
      response_balance=?::numeric, processed_at=now(), next_attempt_at=null where id=?`,
      [code, before.toString(), row.id]);
    await this.event(tx, 'WagerTransactionRejected', row, { kind: row.kind, failureCode: code });
    return { transactionId: row.id, status: 'REJECTED', balance: before.toString(), failureCode: code };
  }

  private async event(tx: EntityManager, eventType: string, row: TransactionRow, data: Record<string, unknown>) {
    const eventId = randomUUID();
    const envelope = {
      eventId, eventType, version: 1, aggregateId: row.wallet_id,
      correlationId: row.id, occurredAt: new Date().toISOString(),
      data: { walletId: row.wallet_id, transactionId: row.id, providerId: row.provider_id, ...data },
    };
    await tx.execute(`insert into outbox_messages (id,aggregate_id,event_type,payload)
      values (?,?,?,?::jsonb)`, [eventId, row.wallet_id, eventType, JSON.stringify(envelope)]);
  }

  private async lockWallet(tx: EntityManager, walletId: string): Promise<WalletRow> {
    // NO KEY UPDATE still serializes balance writers but does not conflict with the
    // KEY SHARE locks taken by FK checks on insert, avoiding lock-upgrade deadlocks.
    const rows = await tx.execute<WalletRow[]>(`
      select id,player_id,currency,balance::text,version from wallets where id=? for no key update`, [walletId]);
    if (rows.length !== 1) throw new Error('WALLET_NOT_FOUND');
    return rows[0];
  }
  private async loadTransaction(tx: EntityManager, id: string): Promise<TransactionRow> {
    const rows = await tx.execute<TransactionRow[]>(`
      select *,amount::text,response_balance::text from wager_transactions where id=?`, [id]);
    if (rows.length !== 1) throw new Error('TRANSACTION_NOT_FOUND');
    return rows[0];
  }
  private snapshot(t: TransactionRow): MovementResult {
    if (!['PROCESSED','REJECTED','PENDING_REFERENCE'].includes(t.status))
      throw new Error('TRANSACTION_NOT_FINALIZED');
    if (t.response_balance === null) throw new Error('RESPONSE_BALANCE_MISSING');
    return { transactionId: t.id, status: t.status as MovementResult['status'],
      balance: t.response_balance, failureCode: t.failure_code };
  }
  private async resultById(tx: EntityManager, id: string) {
    return this.snapshot(await this.loadTransaction(tx, id));
  }
}
