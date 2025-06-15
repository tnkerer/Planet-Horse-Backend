// src/user/dto/withdraw.dto.ts
import { IsNumber, Min } from 'class-validator';

export class WithdrawDto {
  @IsNumber()
  @Min(0.00000001, { message: 'Amount must be greater than zero' })
  amount: number;
}