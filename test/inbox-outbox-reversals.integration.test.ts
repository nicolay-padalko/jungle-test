import { beforeAll, afterAll, test as bunTest, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../mikro-orm.config';
import { WalletMovementsService, type MovementInput } from '../src/application/wallet-movements.service';
import { ReconciliationService } from '../src/application/reconciliation.service';
import { OutboxPublisherService } from '../src/messaging/outbox-publisher.service';

let orm: MikroORM;
let movements: WalletMovementsService;
let reconciliation: ReconciliationService;
const providerId = 'test-provider';

// Opt-in: requires a disposable, migrated PostgreSQL (RUN_DB_TESTS=1); skipped otherwise.
const dbEnabled = process.env.RUN_DB_TESTS === '1';
const test = dbEnabled ? bunTest : bunTest.skip;

beforeAll(async () => {
  if (!dbEnabled) return;
  orm = await MikroORM.init(ormConfig);
  movements = new WalletMovementsService(orm.em);
  reconciliation = new ReconciliationService(orm.em);
});
afterAll(async () => { await orm?.close(true); });

async function openWallet(): Promise<string> {
  const walletId = randomUUID();
  const transactionId = randomUUID();
  // The OPENING entry lets the balance be rebuilt from the ledger.
  await orm.em.transactional(async tx => {
    await tx.execute(`insert into wallets(id,player_id,currency,balance,version)
      values (?,?,'BRL',100.00,1)`, [walletId, randomUUID()]);
    await tx.execute(`insert into wager_transactions
      (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,
       player_id,round_id,game_id,kind,status,amount,currency,response_balance,processed_at)
      select ?, '__internal__', ?, ?, ?, id, player_id, 'opening', 'opening',
        'OPENING','PROCESSED',100.00,'BRL',100.00,now() from wallets where id=?`,
      [transactionId, randomUUID(), randomUUID(), '0'.repeat(64), walletId]);
    await tx.execute(`insert into ledger_entries
      (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
      values (?,?,?,'CREDIT',100.00,'BRL',0.00,100.00)`,
      [randomUUID(), walletId, transactionId]);
  });
  return walletId;
}
function operation(walletId: string, amount: string, ref?: string): MovementInput {
  const key = randomUUID();
  return { walletId, providerId, externalTransactionId: key, idempotencyKey: key,
    roundId: 'round-1', gameId: 'game-1', amount, currency: 'BRL',
    referenceExternalTransactionId: ref };
}
async function ledgerCount(walletId: string): Promise<number> {
  const rows = await orm.em.execute<Array<{ count: string }>>(
    `select count(*)::text as count from ledger_entries where wallet_id=?`, [walletId]);
  return Number(rows[0].count);
}

test('SQS offline: BET commits Wallet + Ledger + Outbox without sending SQS', async () => {
  const id = await openWallet();
  const result = await movements.debit(operation(id,'80.00'));
  expect(result).toMatchObject({ status:'PROCESSED', balance:'20.00' });
  const events = await orm.em.execute<Array<{ event_type: string; published_at: Date | null }>>(
    `select event_type,published_at from outbox_messages
     where payload->'data'->>'transactionId'=? order by event_type`, [result.transactionId]);
  expect(events.map(e=>e.event_type).sort()).toEqual(['WagerTransactionProcessed','WalletBalanceChanged']);
  expect(events.every(e=>e.published_at === null)).toBe(true);
  expect((await reconciliation.reconcile(id)).consistent).toBe(true);
});

test('persistent Inbox: same SQS message twice = one debit, one inbox record', async () => {
  const walletId = await openWallet();
  const input = operation(walletId,'80.00');
  const ctx = { messageId:randomUUID(), consumerName:'wager-commands-v1' };
  const first = await movements.debit(input,ctx);
  const replay = await movements.debit(input,ctx);
  expect(replay).toEqual(first);
  const inbox = await orm.em.execute<Array<{ n: string }>>(
    `select count(*)::text as n from inbox_messages where message_id=?`, [ctx.messageId]);
  expect(Number(inbox[0].n)).toBe(1);
  expect(await ledgerCount(walletId)).toBe(2); // opening + debit
  await expect(movements.debit({...input,amount:'20.00'},ctx)).rejects.toThrow('INBOX_MESSAGE_CONFLICT');
});

test('REFUND before BET persists PENDING_REFERENCE then worker settles', async () => {
  const walletId = await openWallet();
  const bet = operation(walletId,'80.00');
  const refund = operation(walletId,'80.00', bet.externalTransactionId);
  const pending = await movements.refund(refund);
  expect(pending.status).toBe('PENDING_REFERENCE');
  expect((await reconciliation.reconcile(walletId)).consistent).toBe(true);
  expect((await movements.debit(bet)).status).toBe('PROCESSED');
  await orm.em.execute(`update wager_transactions set next_attempt_at=now() where id=?`,[pending.transactionId]);
  expect(await movements.retryPendingReferences()).toBeGreaterThanOrEqual(1);
  const result = await orm.em.execute<Array<{ status:string; response_balance:string }>>(
    `select status,response_balance::text from wager_transactions where id=?`,[pending.transactionId]);
  expect(result[0]).toMatchObject({status:'PROCESSED',response_balance:'100.00'});
  expect(await ledgerCount(walletId)).toBe(3);
  expect((await reconciliation.reconcile(walletId)).consistent).toBe(true);
});

test('same reference cannot be refunded twice', async () => {
  const walletId = await openWallet();
  const bet = operation(walletId,'40.00');
  await movements.debit(bet);
  expect((await movements.refund(operation(walletId,'40.00',bet.externalTransactionId))).status).toBe('PROCESSED');
  const again = await movements.refund(operation(walletId,'40.00',bet.externalTransactionId));
  expect(again).toMatchObject({status:'REJECTED', failureCode:'REFERENCE_ALREADY_REVERSED'});
  expect(await ledgerCount(walletId)).toBe(3);
  expect((await reconciliation.reconcile(walletId)).consistent).toBe(true);
});

test('ROLLBACK of WIN that would go negative is explicitly REJECTED', async () => {
  const walletId = await openWallet();
  const win = operation(walletId,'30.00');
  await movements.credit(win);                        // balance 130.00
  await movements.debit(operation(walletId,'120.00')); // balance 10.00
  const reversal = await movements.rollback(operation(walletId,'30.00',win.externalTransactionId));
  expect(reversal).toMatchObject({status:'REJECTED', balance:'10.00', failureCode:'REVERSAL_INSUFFICIENT_FUNDS'});
  expect(await ledgerCount(walletId)).toBe(3);
  expect((await reconciliation.reconcile(walletId)).consistent).toBe(true);
});

test('ROLLBACK of BET restores funds exactly once', async () => {
  const walletId = await openWallet();
  const bet = operation(walletId,'60.00');
  await movements.debit(bet);
  const rollback = await movements.rollback(operation(walletId,'60.00',bet.externalTransactionId));
  expect(rollback).toMatchObject({status:'PROCESSED', balance:'100.00'});
  expect(await ledgerCount(walletId)).toBe(3);
  expect((await reconciliation.reconcile(walletId)).consistent).toBe(true);
});

test('reconciliation detects mismatch, does not silently fix it', async () => {
  const walletId = await openWallet();
  // Fault injection: corrupt the stored balance directly.
  await orm.em.execute('update wallets set balance=101.00 where id=?',[walletId]);
  const response = await reconciliation.reconcile(walletId);
  expect(response).toMatchObject({consistent:false,
    storedBalance:{amount:'101.00'}, calculatedBalance:{amount:'100.00'},
    difference:{amount:'1.00'}});
});

test('SQS publishing failure keeps event in Outbox for future retry', async () => {
  const walletId = await openWallet();
  await movements.loss(operation(walletId,'0.00'));
  const savedEndpoint = process.env.SQS_ENDPOINT;
  const savedQueue = process.env.SQS_EVENTS_QUEUE_URL;
  process.env.SQS_ENDPOINT = 'http://127.0.0.1:1'; // nothing listens here
  process.env.SQS_EVENTS_QUEUE_URL = 'http://127.0.0.1:1/000000000000/wager-events';
  try {
    // May also claim events left by other tests; they stay pending as well.
    const publisher = new OutboxPublisherService(orm.em);
    expect(await publisher.publishOnce(5)).toBe(0);
    const rows = await orm.em.execute<Array<{n:string}>>(`select count(*)::text as n
      from outbox_messages where attempts>0 and published_at is null`);
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  } finally {
    if (savedEndpoint === undefined) delete process.env.SQS_ENDPOINT;
    else process.env.SQS_ENDPOINT = savedEndpoint;
    if (savedQueue === undefined) delete process.env.SQS_EVENTS_QUEUE_URL;
    else process.env.SQS_EVENTS_QUEUE_URL = savedQueue;
  }
});

// Opt-in (RUN_SQS_TESTS=1): publishes to the real LocalStack queue.
const sqsTest = dbEnabled && process.env.RUN_SQS_TESTS === '1' ? bunTest : bunTest.skip;
sqsTest('LocalStack: outbox publisher confirms only after SendMessage succeeds', async () => {
  const walletId = await openWallet();
  const result = await movements.debit(operation(walletId,'5.00'));
  const publisher = new OutboxPublisherService(orm.em);
  for (let i = 0; i < 20; i++) {
    await publisher.publishOnce(100);
    const pending = await orm.em.execute<Array<{ n:string }>>(`
      select count(*)::text as n from outbox_messages
      where payload->'data'->>'transactionId'=? and published_at is null
    `, [result.transactionId]);
    if (pending[0].n === '0') return;
  }
  throw new Error('Outbox events not published to LocalStack');
});
