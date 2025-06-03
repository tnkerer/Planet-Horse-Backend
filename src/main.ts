import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as cookieParser from 'cookie-parser'
require('dotenv').config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser())
  app.enableCors({
    origin: process.env.SITE_URL || 'http://localhost:3000',   // your front-end URL
    credentials: true,                 // <— allow session cookies
  })
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
