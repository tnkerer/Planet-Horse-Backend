// src/user/dto/withdraw.dto.ts
import { IsNumber, Max, Min } from 'class-validator';

export class WithdrawDto {
  @IsNumber()
  @Min(999, { message: 'Amount must be greater than 999' })
  @Max(100000, { message: 'Maximum withdraw is 100000'})
  amount: number;
}