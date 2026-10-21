import { CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
const dlq = (await sqs.send(new CreateQueueCommand({
  QueueName: 'wager-transactions-dlq.fifo', Attributes: fifo,
}))).QueueUrl!;
const arn = (await sqs.send(new GetQueueAttributesCommand({
  QueueUrl: dlq, AttributeNames: ['QueueArn'],
}))).Attributes!.QueueArn!;
const commands = (await sqs.send(new CreateQueueCommand({
  QueueName: 'wager-transactions.fifo', Attributes: fifo,
}))).QueueUrl!;
await sqs.send(new SetQueueAttributesCommand({
  QueueUrl: commands,
  Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '5' }) },
}));
const events = (await sqs.send(new CreateQueueCommand({
  QueueName: 'wager-events.fifo', Attributes: fifo,
}))).QueueUrl!;
console.log(`SQS_QUEUE_URL=${commands}\nSQS_EVENTS_QUEUE_URL=${events}\nDLQ=${dlq}`);
