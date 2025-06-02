import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as cookieParser from 'cookie-parser'
import { PrismaClient } from '@prisma/client';
require('dotenv').config();

async function bootstrap() {
  const prisma = new PrismaClient();

  try {
    await prisma.$executeRawUnsafe(`SELECT 1`);
    await prisma.$disconnect();

    // Run migrations (optional if schema is already synced)
    const { exec } = await import('child_process');
    exec('npx prisma migrate deploy', (err, stdout, stderr) => {
      if (err) {
        console.error('Migration error:', stderr);
      } else {
        console.log('Migration result:', stdout);
      }
    });
  } catch (error) {
    console.error('Could not connect to the database.', error);
  }
  
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser())
  app.enableCors({
    origin: 'http://localhost:3000',   // your front-end URL
    credentials: true,                 // <— allow session cookies
  })
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
