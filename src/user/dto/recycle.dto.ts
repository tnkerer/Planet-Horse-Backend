// src/user/dto/recycle.dto.ts
import { IsString, IsInt, Min } from 'class-validator';

export class RecycleDto {
  @IsString()           name: string;

  @IsInt()
  @Min(1)
  uses: number;

  @IsInt()
  @Min(1)
  quantity: number;
}
