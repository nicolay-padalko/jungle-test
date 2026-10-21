import { Module } from '@nestjs/common';
import { WalletMovementsModule } from '../application/wallet-movements.module';
import { ReconciliationService } from '../application/reconciliation.service';
import { WagerController, WalletReconciliationController } from './wager.controller';

@Module({
  imports: [WalletMovementsModule],
  providers: [ReconciliationService],
  controllers: [WagerController, WalletReconciliationController],
})
export class WagerHttpModule {}
