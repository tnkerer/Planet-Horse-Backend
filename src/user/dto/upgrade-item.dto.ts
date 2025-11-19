import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpgradeItemDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsBoolean()
  @IsOptional()
  useClover?: boolean;
}