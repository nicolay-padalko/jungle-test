import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../domain/money/money';

type Result = {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
};

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  constructor(private readonly em: EntityManager) {}

  async reconcile(walletId: string): Promise<Result> {
    return this.em.transactional(async tx => {
      // Conflicts with the FOR NO KEY UPDATE taken by writers, so balance and
      // ledger cannot change while they are compared.
      const wallets = await tx.execute<Array<{ balance: string; currency: string }>>(`
        select balance::text, currency from wallets where id=? for update`, [walletId]);
      if (wallets.length !== 1) throw new Error('WALLET_NOT_FOUND');
      const wallet = wallets[0];
      const ledger = await tx.execute<Array<{ calculated: string; count: string }>>(`
        select coalesce(sum(case when direction='CREDIT' then amount else -amount end),0)::numeric(20,2)::text
          as calculated, count(*)::text as count
        from ledger_entries where wallet_id=?`, [walletId]);
      const stored = Money.from({ amount: wallet.balance, currency: wallet.currency });
      const calculated = Money.rehydrate({ amount: ledger[0].calculated, currency: wallet.currency });
      const difference = stored.subtract(calculated);
      const consistent = difference.isZero();
      if (!consistent) this.logger.error(JSON.stringify({ walletId, issue: 'LEDGER_BALANCE_MISMATCH' }));
      return {
        walletId, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(), consistent, checkedEntries: Number(ledger[0].count),
      };
    });
  }
}
