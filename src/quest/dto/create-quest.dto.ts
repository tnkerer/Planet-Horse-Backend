import { IsString, IsInt, IsArray, IsEnum, Min, Max, ValidateNested, IsBoolean, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

enum QuestDifficulty {
  SIMPLE = 'SIMPLE',
  MEDIUM = 'MEDIUM',
  ADVANCED = 'ADVANCED',
}

enum QuestType {
  WIN_RACES = 'WIN_RACES',
  RUN_RACES = 'RUN_RACES',
  BREED_HORSES = 'BREED_HORSES',
  LEVEL_UP_HORSES = 'LEVEL_UP_HORSES',
  EQUIP_ITEMS = 'EQUIP_ITEMS',
  OPEN_CHESTS = 'OPEN_CHESTS',
  SPEND_PHORSE = 'SPEND_PHORSE',
  EARN_PHORSE = 'EARN_PHORSE',
  UPGRADE_ITEMS = 'UPGRADE_ITEMS',
  RECYCLE_ITEMS = 'RECYCLE_ITEMS',
  RESTORE_ENERGY = 'RESTORE_ENERGY',
  CLAIM_REWARDS = 'CLAIM_REWARDS',
  DAILY_CHECKIN = 'DAILY_CHECKIN',
}

class RewardItem {
  @IsString()
  type: string;

  @IsInt()
  @Min(1)
  amount: number;

  @IsString()
  itemName?: string;
}

export class CreateQuestDto {
  @IsInt()
  @Min(1)
  @Max(29999)
  id: number;

  @IsString()
  title: string;

  @IsString()
  description: string;

  @IsEnum(QuestType)
  questType: QuestType;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RewardItem)
  reward: RewardItem[];

  @IsInt()
  @Min(1)
  questsToComplete: number;

  @IsEnum(QuestDifficulty)
  difficulty: QuestDifficulty;

  @IsOptional()
  @IsBoolean()
  isDailyQuest?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  horsesToUnlock?: number;
}
