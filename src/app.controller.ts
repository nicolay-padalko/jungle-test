import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

@Controller('health')
export class AppController {
  constructor(private readonly em: EntityManager) {}

  @Get('live')
  live() { return { status: 'ok' }; }

  @Get('ready')
  async ready() {
    try {
      await this.em.getConnection().execute('select 1');
      return { status: 'ok', postgres: 'connected' };
    } catch {
      throw new ServiceUnavailableException('PostgreSQL unavailable');
    }
  }
}
