import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from '../mikro-orm.config';
import { AppController } from './app.controller';
import { WagerHttpModule } from './presentation/wager-http.module';

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig), WagerHttpModule],
  controllers: [AppController],
})
export class AppModule {}
