import { IsInt, Min } from 'class-validator';

export class ClaimQuestDto {
  @IsInt()
  @Min(1)
  questId: number;
}
