import { IsString } from 'class-validator';

export class UpgradeItemDto {
  @IsString()
  name: string;
}
