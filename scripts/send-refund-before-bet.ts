import { randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
const walletId = process.env.TEST_WALLET_ID;
if (!walletId) throw new Error('Set TEST_WALLET_ID to a real UUID wallet');
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId:'test', secretAccessKey:'test' },
});
const queueUrl = process.env.SQS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
const ref = `bet-${randomUUID()}`;
for (const kind of ['REFUND','BET'] as const) {
  const externalTransactionId = kind === 'BET' ? ref : `refund-${randomUUID()}`;
  const messageId = randomUUID();
  const body = {
    messageId, type:'WagerTransactionRequested', occurredAt:new Date().toISOString(),
    data: {
      kind, walletId, providerId: 'demo', externalTransactionId,
      idempotencyKey: `demo:${externalTransactionId}`, roundId: 'demo-round', gameId: 'demo-game',
      money: {amount:'20.00',currency:'BRL'},
      ...(kind === 'REFUND' ? {referenceExternalTransactionId: ref}: {}),
    },
  };
  await sqs.send(new SendMessageCommand({
    QueueUrl:queueUrl, MessageBody: JSON.stringify(body),
    ...(queueUrl.endsWith('.fifo') ? {
      MessageGroupId:walletId, MessageDeduplicationId:messageId,
    } : {}),
  }));
  console.log(kind, externalTransactionId, messageId);
}
