import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as cookieParser from 'cookie-parser'
import { PrismaClient } from '@prisma/client';
import { promisify } from 'util';
import { exec } from 'child_process';
require('dotenv').config();

const asyncExec = promisify(exec);

async function bootstrap() {
  const prisma = new PrismaClient();

try {
    // Check DB connection
    await prisma.$queryRaw`SELECT 1`;

    console.log('Connected to database. Running Prisma migration...');
    const { stdout, stderr } = await asyncExec('npx prisma migrate deploy');

    if (stderr) {
      console.error('Migration stderr:', stderr);
    } else {
      console.log('Migration stdout:', stdout);
    }
  } catch (err) {
    console.error('Error connecting to database or running migration:', err);
  } finally {
    await prisma.$disconnect();
  }

  const app = await NestFactory.create(AppModule);
  app.use(cookieParser())
  app.enableCors({
    origin: process.env.SITE_URL || 'http://localhost:3000',   // your front-end URL
    credentials: true,                 // <— allow session cookies
  })
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
