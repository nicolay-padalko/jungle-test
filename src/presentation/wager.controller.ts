import { Body, Controller, Param, Post } from '@nestjs/common';
import { WalletMovementsService, type MovementInput } from '../application/wallet-movements.service';
import { ReconciliationService } from '../application/reconciliation.service';

/** Demo routes: no auth, body validation or HTTP error mapping yet. */
@Controller('wagers')
export class WagerController {
  constructor(private readonly movements: WalletMovementsService) {}
  @Post('bet') bet(@Body() input: MovementInput) { return this.movements.debit(input); }
  @Post('win') win(@Body() input: MovementInput) { return this.movements.credit(input); }
  @Post('loss') loss(@Body() input: MovementInput) { return this.movements.loss(input); }
  @Post('refund') refund(@Body() input: MovementInput) { return this.movements.refund(input); }
  @Post('rollback') rollback(@Body() input: MovementInput) { return this.movements.rollback(input); }
}

@Controller('wallets')
export class WalletReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}
  @Post(':walletId/reconciliation') reconcile(@Param('walletId') id: string) {
    return this.reconciliation.reconcile(id);
  }
}
