import { IsArray, IsDateString, IsInt, IsNumber, IsOptional, IsPositive, IsString, Max, Min } from 'class-validator';

export class CreateDerbyDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  registrationOpensAt: string; // ISO string

  @IsDateString()
  startsAt: string; // ISO string

  @IsOptional()
  @IsInt()
  @Min(0)
  maxMmr?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxParticipants?: number;

  @IsNumber()
  @Min(0)
  wronEntryFee: number;

  @IsNumber()
  @Min(0)
  phorseEntryFee: number;

  // 0..1 portion of total WRON pot that goes to winners
  @IsNumber()
  @Min(0)
  @Max(1)
  wronPayoutPercent: number;

  @IsArray()
  @IsString({ each: true })
  allowedRarities: string[];
}

export class AssignHorseDto {
  @IsString()
  horseId: string;
}

export class RemoveHorseDto {
  @IsString()
  horseId: string;
}

export class PlaceBetDto {
  horseId: string; // horse in this derby you're betting on
  amount: number;  // WRON amount to bet
}

export interface HorseOdds {
  horseId: string;
  totalStaked: number;
  oddsMultiplier: number | null;
  userStake?: number;
  userPotentialPayout?: number;
}

export interface DerbyOddsResponse {
  raceId: string;
  totalStaked: number;
  poolAmount: number;
  horses: HorseOdds[];
}

