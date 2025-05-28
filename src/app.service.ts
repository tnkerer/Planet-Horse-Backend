import { Injectable } from '@nestjs/common';
require('dotenv').config();

@Injectable()
export class AppService {
  getHello(): string {
    return `Service being served at PORT ${process.env.PORT}!`;
  }
}
