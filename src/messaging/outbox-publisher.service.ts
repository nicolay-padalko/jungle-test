import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

type DueEvent = { id: string; payload: unknown; aggregate_id: string; attempts: number };

/**
 * At-least-once publisher. Rows are claimed with a lease so no database transaction
 * stays open during the SQS call. A crash between sending and marking published_at
 * re-sends the event, so consumers dedupe by eventId.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly log = new Logger(OutboxPublisherService.name);
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  private readonly queueUrl =
  process.env.SQS_EVENTS_QUEUE_URL ??
  'http://127.0.0.1:4566/000000000000/wager-events.fifo';
  private stopping = false;

  constructor(private readonly em: EntityManager) {}

  async publishOnce(limit = 10): Promise<number> {
    const owner = randomUUID();
    const rows = await this.em.transactional(async tx =>
      tx.execute<DueEvent[]>(`
        with selected as (
          select id from outbox_messages
          where published_at is null and next_attempt_at <= now()
            and (leased_until is null or leased_until < now())
          order by next_attempt_at, id
          limit ? for update skip locked
        )
        update outbox_messages o
           set lease_owner=?, leased_until=now()+interval '60 seconds',
               attempts=o.attempts+1
        from selected s where o.id=s.id
        returning o.id, o.payload, o.aggregate_id, o.attempts
      `, [limit, owner]));

    let published = 0;
    for (const row of rows) {
      try {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        await this.client.send(new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(payload),
          ...(this.queueUrl.endsWith('.fifo') ? {
            MessageGroupId: row.aggregate_id,
            MessageDeduplicationId: row.id,
          } : {}),
        }));
        await this.em.execute(`update outbox_messages
          set published_at=now(), lease_owner=null, leased_until=null
          where id=? and lease_owner=? and published_at is null`, [row.id, owner]);
        published++;
      } catch (err) {
        this.log.error(JSON.stringify({ eventId: row.id, error: String(err), attempts: row.attempts }));
        const backoffSeconds = Math.min(300, 2 ** Math.min(row.attempts, 8));
        await this.em.execute(`update outbox_messages
          set next_attempt_at=now()+(?::integer * interval '1 second'),
            lease_owner=null, leased_until=null
          where id=? and lease_owner=? and published_at is null`,
          [backoffSeconds, row.id, owner]);
      }
    }
    return published;
  }

  async run(): Promise<void> {
    this.stopping = false;
    while (!this.stopping) {
      try { await this.publishOnce(); }
      catch (error) { this.log.error(`Outbox loop: ${String(error)}`); }
      await Bun.sleep(1000);
    }
  }
  stop(): void { this.stopping = true; }
}
