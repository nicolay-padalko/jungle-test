import { Module } from '@nestjs/common';
import { WalletMovementsService } from './wallet-movements.service';

@Module({
  providers: [WalletMovementsService],
  exports: [WalletMovementsService],
})
export class WalletMovementsModule {}
