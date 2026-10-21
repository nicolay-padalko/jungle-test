import { Module } from '@nestjs/common';
import { WalletMovementsModule } from '../application/wallet-movements.module';
import { SqsConsumerService } from './sqs-consumer.service';
import { OutboxPublisherService } from './outbox-publisher.service';

@Module({
  imports: [WalletMovementsModule],
  providers: [SqsConsumerService, OutboxPublisherService],
  exports: [SqsConsumerService, OutboxPublisherService],
})
export class SqsModule {}
