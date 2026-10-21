import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';
import { Migration202610200001 } from '../src/migrations/Migration202610200001';
import { Migration202610200002 } from '../src/migrations/Migration202610200002';
import { Migration202610210001 } from '../src/migrations/Migration202610210001';
import { Migration202610210003 } from '../src/migrations/Migration202610210003';
import { WalletMovementsService, type MovementInput } from '../src/application/wallet-movements.service';

// Opt-in (RUN_DB_TESTS=1): runs against a real PostgreSQL; connection errors fail the suite.
describe.skipIf(process.env.RUN_DB_TESTS !== '1')('Wallet movements / PostgreSQL', () => {
  let orm: MikroORM;
  let schema: string;
  let service: WalletMovementsService;
  let walletId: string;
  const schemas: string[] = [];

  async function scoped<T>(work: (tx: EntityManager) => Promise<T>): Promise<T> {
    return orm.em.fork().transactional(async tx => {
      await tx.execute(`set local search_path to "${schema}"`);
      return work(tx);
    });
  }
  const query = (sql: string, params: unknown[] = []) =>
    scoped(tx => tx.execute<any[]>(sql, params));
  const input = (changes: Partial<MovementInput> = {}): MovementInput => ({
    walletId, providerId: 'provider-test', externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(), roundId: 'round-1', gameId: 'game-1',
    amount: '10.00', currency: 'BRL', ...changes,
  });

  beforeAll(async () => { orm = await MikroORM.init(config); });
  beforeEach(async () => {
    schema = `test_wallet_${randomUUID().replaceAll('-', '')}`;
    await orm.em.getConnection().execute(`create schema "${schema}"`);
    schemas.push(schema);
    const statements: string[] = [];
    // Each test gets its own schema with every migration applied.
    for (const migration of [
      Migration202610200001,
      Migration202610200002,
      Migration202610210001,
      Migration202610210003,
    ]) {
      await migration.prototype.up.call({
        addSql: (sql: string) => statements.push(sql),
      } as unknown as InstanceType<typeof migration>);
    }
    await scoped(async tx => {
      for (const sql of statements) await tx.execute(sql);
    });
    walletId = randomUUID();
    await query('insert into wallets (id, player_id, currency) values (?, ?, ?)',
      [walletId, randomUUID(), 'BRL']);
    service = new WalletMovementsService({ transactional: scoped } as unknown as EntityManager);
  });
  // Schemas are tracked so they are dropped even when a test fails.
  afterAll(async () => {
    if (!orm) return;
    try {
      for (const name of schemas) await orm.em.getConnection().execute(`drop schema "${name}" cascade`);
    } finally { await orm.close(); }
  });

  test('new wallet starts at zero with no movements', async () => {
    expect((await query('select balance::text, version from wallets'))[0])
      .toEqual({ balance: '0.00', version: 1 });
    expect(await query('select * from ledger_entries')).toHaveLength(0);
    expect(await query('select * from wager_transactions')).toHaveLength(0);
  });

  test.todo('open wallet through the service with initial balance and OPENING entry (not implemented yet)');

  test('database blocks a second wallet for the same player and currency', async () => {
    const [wallet] = await query('select player_id from wallets where id = ?', [walletId]);
    await expect(query('insert into wallets (id, player_id, currency) values (?, ?, ?)',
      [randomUUID(), wallet.player_id, 'BRL'])).rejects.toThrow();
    await query('insert into wallets (id, player_id, currency) values (?, ?, ?)',
      [randomUUID(), wallet.player_id, 'USD']);
    expect(await query('select * from wallets')).toHaveLength(2);
  });

  test('database rejects negative balance and unsupported currency', async () => {
    await expect(query('update wallets set balance = -0.01 where id = ?', [walletId])).rejects.toThrow();
    await expect(query('insert into wallets (id, player_id, currency) values (?, ?, ?)',
      [randomUUID(), randomUUID(), 'XYZ'])).rejects.toThrow();
  });

  test('credit overflow rolls back every effect', async () => {
    await service.credit(input({ amount: '999999999999999999.99' }));
    await expect(service.credit(input({ amount: '0.01' }))).rejects.toThrow('MONEY_OUT_OF_RANGE');
    expect((await query('select balance::text, version from wallets'))[0])
      .toEqual({ balance: '999999999999999999.99', version: 2 });
    expect(await query('select * from wager_transactions')).toHaveLength(1);
    expect(await query('select * from ledger_entries')).toHaveLength(1);
  });

  test('insufficient funds is terminal and leaves balance, version and ledger untouched', async () => {
    const request = input();
    const result = await service.debit(request);
    expect(result).toMatchObject({ status: 'REJECTED', balance: '0.00', failureCode: 'INSUFFICIENT_FUNDS' });
    await service.credit(input({ amount: '20.00' }));
    expect(await service.debit(request)).toEqual(result);
    expect((await query('select balance::text, version from wallets'))[0])
      .toEqual({ balance: '20.00', version: 2 });
    expect(await query('select * from ledger_entries')).toHaveLength(1);
    expect((await query("select status, failure_code, response_balance::text from wager_transactions where id = ?", [result.transactionId]))[0])
      .toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', response_balance: '0.00' });
  });

  test.each(['debit', 'credit'] as const)('%s rejects a different currency without persisting anything', async method => {
    await expect(service[method](input({ currency: 'USD' })))
      .rejects.toThrow('WALLET_NOT_FOUND_OR_CURRENCY_MISMATCH');
    expect(await query('select * from wager_transactions')).toHaveLength(0);
    expect(await query('select * from ledger_entries')).toHaveLength(0);
    expect((await query('select balance::text from wallets'))[0].balance).toBe('0.00');
  });

  test('unknown wallet has a specific error', async () => {
    await expect(service.credit(input({ walletId: randomUUID() })))
      .rejects.toThrow('WALLET_NOT_FOUND_OR_CURRENCY_MISMATCH');
  });

  test.each(['debit', 'credit'] as const)('%s rejects zero before persisting', async method => {
    await expect(service[method](input({ amount: '0.00' }))).rejects.toThrow('AMOUNT_MUST_BE_POSITIVE');
    expect(await query('select * from wager_transactions')).toHaveLength(0);
  });

  test('credits minus debits match the balance and keep the ledger chain', async () => {
    await service.credit(input({ amount: '100.00' }));
    const bet = input({ amount: '80.00' });
    const result = await service.debit(bet);
    expect(await service.debit(bet)).toEqual(result);
    await service.credit(input({ amount: '0.10' }));
    await service.credit(input({ amount: '0.20' }));
    await service.debit(input({ amount: '20.30' }));
    const ledger = await query('select direction, amount::text, balance_before::text, balance_after::text from ledger_entries order by created_at');
    expect(ledger.map((row: any) => [row.balance_before, row.balance_after])).toEqual([
      ['0.00', '100.00'], ['100.00', '20.00'], ['20.00', '20.10'],
      ['20.10', '20.30'], ['20.30', '0.00'],
    ]);
    const [totals] = await query(`select w.balance::text, w.version,
      (select sum(case when direction = 'CREDIT' then amount else -amount end)
       from ledger_entries where wallet_id = w.id)::text as ledger_balance from wallets w`);
    expect(totals).toEqual({ balance: '0.00', version: 6, ledger_balance: '0.00' });
    expect(await query("select * from wager_transactions where status <> 'PROCESSED'" )).toHaveLength(0);
  });

  test('conflicting payload does not repeat the credit', async () => {
    const request = input();
    await service.credit(request);
    await expect(service.credit({ ...request, amount: '11.00' })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await query('select * from ledger_entries')).toHaveLength(1);
  });

  test('50 identical requests produce a single debit and return the stored result', async () => {
    await service.credit(input({ amount: '100.00' }));
    const request = input({ amount: '80.00' });
    // No shared cache: each service instance opens its own transaction.
    const results = await Promise.all(Array.from({ length: 50 }, () => {
      const instance = new WalletMovementsService({ transactional: scoped } as unknown as EntityManager);
      return instance.debit({ ...request });
    }));
    expect(results).toHaveLength(50);
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).toMatchObject({ status: 'PROCESSED', balance: '20.00', failureCode: null });
    expect((await query('select balance::text, version from wallets'))[0])
      .toEqual({ balance: '20.00', version: 3 });
    expect(await query("select id from wager_transactions where kind = 'BET'"))
      .toEqual([{ id: results[0].transactionId }]);
    expect(await query("select transaction_id, amount::text from ledger_entries where direction = 'DEBIT'"))
      .toEqual([{ transaction_id: results[0].transactionId, amount: '80.00' }]);

    // Change the balance and restart the ORM: the replay must still return the original balance.
    await service.credit(input({ amount: '10.00' }));
    const restarted = await MikroORM.init(config);
    try {
      const fresh = new WalletMovementsService({
        transactional: <T>(work: (tx: EntityManager) => Promise<T>) =>
          restarted.em.fork().transactional(async tx => {
            await tx.execute(`set local search_path to "${schema}"`);
            return work(tx);
          }),
      } as unknown as EntityManager);
      expect(await fresh.debit(request)).toEqual(results[0]);
    } finally { await restarted.close(); }
    expect((await query('select balance::text, version from wallets'))[0])
      .toEqual({ balance: '30.00', version: 4 });
    expect(await query("select * from ledger_entries where direction = 'DEBIT'" )).toHaveLength(1);
  });

  test('same key with a different payload conflicts without a new debit', async () => {
    await service.credit(input({ amount: '100.00' }));
    const request = input({ amount: '10.00' });
    const original = await service.debit(request);
    for (const changes of [
      { amount: '11.00' }, { roundId: 'other-round' }, { gameId: 'other-game' },
      { externalTransactionId: randomUUID() },
    ]) {
      await expect(service.debit({ ...request, ...changes })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    }
    await expect(service.credit(request)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await service.debit(request)).toEqual(original);
    expect((await query('select balance::text from wallets'))[0].balance).toBe('90.00');
    expect(await query("select * from ledger_entries where direction = 'DEBIT'" )).toHaveLength(1);
  });

  test('unique index protects provider + key in the database and allows another provider', async () => {
    await service.credit(input({ amount: '100.00' }));
    const request = input();
    const original = await service.debit(request);
    // Bypass the service to prove the guarantee lives in the database.
    await expect(query(`insert into wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, status, amount, currency)
      select ?, provider_id, ?, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, 'PENDING', amount, currency
      from wager_transactions where id = ?`,
      [randomUUID(), randomUUID(), original.transactionId]))
      .rejects.toThrow('uq_wager_provider_idempotency');
    const other = await service.debit({ ...request, providerId: 'other-provider' });
    expect(other.transactionId).not.toBe(original.transactionId);
    expect(other.balance).toBe('80.00');
    expect(await query("select * from ledger_entries where direction = 'DEBIT'" )).toHaveLength(2);
  });

  test('two concurrent 80.00 bets compete for 100.00 under a real lock', async () => {
    await service.credit(input({ amount: '100.00' }));
    const backendIds: number[] = [];
    // Each call uses its own transaction and connection, like separate instances.
    const contender = () => new WalletMovementsService({
      transactional: <T>(work: (tx: EntityManager) => Promise<T>) => scoped(async tx => {
        const [backend] = await tx.execute<Array<{ pid: number }>>('select pg_backend_pid() as pid');
        backendIds.push(backend.pid);
        return work(tx);
      }),
    } as unknown as EntityManager);
    let outcomes!: PromiseSettledResult<Awaited<ReturnType<typeof service.debit>>>[];
    let pending: Promise<typeof outcomes> | undefined;
    try {
      await scoped(async blocker => {
        await blocker.execute('select id from wallets where id = ? for update', [walletId]);
        pending = Promise.allSettled([
          contender().debit(input({ amount: '80.00' })),
          contender().debit(input({ amount: '80.00' })),
        ]);
        const deadline = Date.now() + 3000;
        let waiting = 0;
        while (Date.now() < deadline) {
          if (backendIds.length === 2) {
            const [row] = await query(`select count(*)::int as waiting from pg_stat_activity
              where pid in (?, ?) and wait_event_type = 'Lock'`, backendIds);
            waiting = row.waiting;
            if (waiting === 2) break;
          }
          await Bun.sleep(10);
        }
        expect(new Set(backendIds).size).toBe(2);
        expect(waiting).toBe(2);
        // Release the wallet only after both sessions are seen waiting on the lock.
      });
    } finally {
      if (pending) outcomes = await pending;
    }
    const results = outcomes.map(outcome => {
      if (outcome.status === 'rejected') throw outcome.reason;
      return outcome.value;
    });
    expect(results.map(result => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find(result => result.status === 'REJECTED'))
      .toMatchObject({ balance: '20.00', failureCode: 'INSUFFICIENT_FUNDS' });
    expect((await query('select balance::text, version from wallets'))[0])
      .toEqual({ balance: '20.00', version: 3 });
    expect(await query("select * from wager_transactions where kind = 'BET' and status = 'PROCESSED'"))
      .toHaveLength(1);
    expect(await query("select * from wager_transactions where kind = 'BET' and status = 'REJECTED'"))
      .toHaveLength(1);
    expect(await query("select amount::text, balance_before::text, balance_after::text from ledger_entries where direction = 'DEBIT'"))
      .toEqual([{ amount: '80.00', balance_before: '100.00', balance_after: '20.00' }]);
    expect(await query('select * from ledger_entries')).toHaveLength(2);
  });

  test('ledger blocks updates and deletes', async () => {
    await service.credit(input());
    await expect(query('update ledger_entries set amount = 20')).rejects.toThrow('append-only');
    await expect(query('delete from ledger_entries')).rejects.toThrow('append-only');
    expect((await query('select amount::text from ledger_entries'))[0].amount).toBe('10.00');
  });

  test('ledger insert failure rolls back balance and transaction', async () => {
    await query(`create function fail_ledger() returns trigger as $$ begin
      raise exception 'TEST_LEDGER_FAILURE'; end; $$ language plpgsql`);
    await query('create trigger fail_ledger before insert on ledger_entries for each row execute function fail_ledger()');
    await expect(service.credit(input())).rejects.toThrow('TEST_LEDGER_FAILURE');
    expect((await query('select balance::text, version from wallets'))[0]).toEqual({ balance: '0.00', version: 1 });
    expect(await query('select * from wager_transactions')).toHaveLength(0);
  });
});
