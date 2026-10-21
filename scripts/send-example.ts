import { randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
const walletId = process.env.TEST_WALLET_ID;
if (!walletId) throw new Error('Set TEST_WALLET_ID to an existing wallet UUID');
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId:'test', secretAccessKey:'test' },
});
const queueUrl = process.env.SQS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
const externalTransactionId = `bet-${randomUUID()}`;
const messageId = randomUUID();
const body = {
  messageId, type:'WagerTransactionRequested', occurredAt:new Date().toISOString(),
  data: {
    kind: 'BET', walletId, providerId: 'demo', externalTransactionId,
    idempotencyKey: `demo:${externalTransactionId}`, roundId: 'demo-round', gameId: 'demo-game',
    money: { amount: process.env.AMOUNT ?? '10.00', currency: 'BRL' },
  },
};
await sqs.send(new SendMessageCommand({
  QueueUrl: queueUrl, MessageBody: JSON.stringify(body),
  ...(queueUrl.endsWith('.fifo') ? {
    MessageGroupId: walletId, MessageDeduplicationId: messageId,
  } : {}),
}));
console.log(JSON.stringify(body, null, 2));
