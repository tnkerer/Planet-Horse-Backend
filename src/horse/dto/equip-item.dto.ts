import { IsString, IsNotEmpty, IsInt, Min } from 'class-validator';

export class EquipItemDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsInt()
  @Min(1)
  usesLeft: number;
}