// src/user/dto/withdraw.dto.ts
import { IsNumber, Min } from 'class-validator';

export class WithdrawDto {
  @IsNumber()
  @Min(999, { message: 'Amount must be greater than 999' })
  amount: number;
}