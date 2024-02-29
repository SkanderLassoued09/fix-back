import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.use(bodyParser.json({ limit: '5gb' }));
  app.use(bodyParser.urlencoded({ limit: '5gb', extended: true }));

  await app.listen(3000);
}
bootstrap();
