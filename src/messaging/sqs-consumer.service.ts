import { Injectable, Logger } from '@nestjs/common';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { WalletMovementsService, type MovementInput } from '../application/wallet-movements.service';

type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
type CommandEnvelope = {
  messageId: string;
  type: 'WagerTransactionRequested';
  data: {
    kind: Kind;
    walletId: string; providerId: string; externalTransactionId: string;
    idempotencyKey: string; roundId: string; gameId: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
};

@Injectable()
export class SqsConsumerService {
  private readonly logger = new Logger(SqsConsumerService.name);
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  private readonly queueUrl =
  process.env.SQS_QUEUE_URL ??
  'http://127.0.0.1:4566/000000000000/wager-transactions.fifo';
  private stopping = false;
  constructor(private readonly movements: WalletMovementsService) {}

  async pollOnce(): Promise<number> {
    const batch = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl, MaxNumberOfMessages: 5,
      WaitTimeSeconds: 2, VisibilityTimeout: 60,
    }));
    let processed = 0;
    for (const message of batch.Messages ?? []) {
      if (!message.ReceiptHandle) continue;
      try {
        const envelope = JSON.parse(message.Body ?? '') as CommandEnvelope;
        if (envelope.type !== 'WagerTransactionRequested' ||
            !envelope.messageId || !envelope.data?.money ||
            !['BET','WIN','LOSS','REFUND','ROLLBACK'].includes(envelope.data.kind)) {
          throw new Error('INVALID_COMMAND_ENVELOPE');
        }
        const data = envelope.data;
        const input: MovementInput = {
          walletId: data.walletId, providerId: data.providerId,
          externalTransactionId: data.externalTransactionId,
          idempotencyKey: data.idempotencyKey, roundId: data.roundId,
          gameId: data.gameId, amount: data.money.amount,
          currency: data.money.currency,
          referenceExternalTransactionId: data.referenceExternalTransactionId,
        };
        await this.movements.process(data.kind, input, {
          messageId: envelope.messageId, consumerName: 'wager-commands-v1',
        });
        // Ack after commit: a crash before this point only causes a redelivery, absorbed by the inbox.
        await this.client.send(new DeleteMessageCommand({
          QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle,
        }));
        processed++;
      } catch (error) {
        this.logger.error(`Message not acknowledged: ${String(error)}`);
        // No ack: the message reappears after the visibility timeout; the redrive policy moves it to the DLQ.
      }
    }
    return processed;
  }
  async run(): Promise<void> {
    this.stopping = false;
    while (!this.stopping) {
      try { await this.pollOnce(); }
      catch (error) { this.logger.error(`SQS poll failed: ${String(error)}`); await Bun.sleep(1000); }
    }
  }
  stop() { this.stopping = true; }
}
