import { IsString, IsNotEmpty } from 'class-validator';

export class UnequipItemDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}