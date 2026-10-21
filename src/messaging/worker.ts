import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from '../../mikro-orm.config';
import { SqsModule } from './sqs.module';
import { SqsConsumerService } from './sqs-consumer.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { WalletMovementsService } from '../application/wallet-movements.service';

@Module({ imports: [MikroOrmModule.forRoot(ormConfig), SqsModule] })
class WorkerModule {}

const app = await NestFactory.createApplicationContext(WorkerModule);
const incoming = app.get(SqsConsumerService);
const outgoing = app.get(OutboxPublisherService);
const movements = app.get(WalletMovementsService);
let stopping = false;
process.on('SIGINT', () => { stopping = true; incoming.stop(); outgoing.stop(); });
process.on('SIGTERM', () => { stopping = true; incoming.stop(); outgoing.stop(); });

try {
  await Promise.all([
    incoming.run(),
    outgoing.run(),
    (async () => {
      while (!stopping) {
        try { await movements.retryPendingReferences(); }
        catch (error) { console.error('Pending reference retry failed', error); }
        await Bun.sleep(1000);
      }
    })(),
  ]);
} finally {
  await app.close();
}
