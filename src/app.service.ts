import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, TraitTier } from '@prisma/client';

type OpenSeaAttribute =
  | { trait_type: string; value: string | number; display_type?: 'number' | 'boost_number' | 'boost_percentage' | 'date' }
  | { trait_type: string; value: string; display_type?: undefined | null };

@Injectable()
export class AppService {
  private prisma = new PrismaClient();

  private externalUrl = 'https://planethorse.io/';

  getHello(): string {
    return `PlanetHorse API service is online!`;
  }

  private toTitle(s: string) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
  }

  private prettyTier(t: TraitTier): string {
    switch (t) {
      case 'COMMON': return 'Common';
      case 'RARE': return 'Rare';
      case 'MYTHIC': return 'Mythic';
      default: return this.toTitle(String(t));
    }
  }

  private formatSex(sex: 'MALE' | 'FEMALE') {
    return sex.toLowerCase();
  }

  private horseTypeFromGen(gen: number): string {
    return gen === 0 ? 'Origin' : 'Offspring';
  }

  /** slugify("Blue Roan") => "blue-roan" */
  private slugifyName(name: string): string {
    return (name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')   // remove diacritics
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, '')     // allow letters, digits, space, apostrophe, hyphen
      .trim()
      .replace(/\s+/g, '-')              // spaces -> hyphens
      .replace(/-+/g, '-');              // collapse multiple hyphens
  }

  /** Build image URL: https://planethorse.io/assets/game/horses/gifs/${rarity}/${name-slug}-running.gif */
  private buildImageUrl(horseName: string, rarity: string): string {
    const NAME_SLUG = `${this.slugifyName(horseName)}-running`;
    const RARITY = (rarity || 'common').toLowerCase(); // lowercased folder name (covers "Common" => "common")
    return `https://planethorse.io/assets/game/horses/gifs/${RARITY}/${NAME_SLUG}.gif`;
  }

  async getHorseMetadata(tokenId: string) {
    const horse = await this.prisma.horse.findUnique({
      where: { tokenId },
      include: {
        traits: {
          include: { trait: true },
          orderBy: { slot: 'asc' },
        },
      },
    });

    if (!horse) throw new NotFoundException(`Horse with tokenId ${tokenId} not found`);

    const horseType = this.horseTypeFromGen(horse.gen);
    const rarityDisplay = this.toTitle(horse.rarity);
    const image = this.buildImageUrl(horse.name, horse.rarity);

    const attrs: OpenSeaAttribute[] = [
      { trait_type: 'horse type', value: horseType },
      { trait_type: 'rarity', value: rarityDisplay },
      { trait_type: 'gender', value: this.formatSex(horse.sex) },
      { trait_type: 'breeding count', value: `${horse.currentBreeds}/${horse.maxBreeds ? horse.maxBreeds : 0}` },

      { trait_type: 'parent 1', value: horse.parents[0] ? `${horse.parents[0]}` : 'none' },
      { trait_type: 'parent 2', value: horse.parents[1] ? `${horse.parents[1]}` : 'none' },

      { trait_type: 'exp', value: horse.exp, display_type: 'number' },
      { trait_type: 'level', value: horse.level, display_type: 'number' },

      { trait_type: 'base power', value: horse.basePower, display_type: 'number' },
      { trait_type: 'base sprint', value: horse.baseSprint, display_type: 'number' },
      { trait_type: 'base speed', value: horse.baseSpeed, display_type: 'number' },

      { trait_type: 'current power', value: horse.currentPower, display_type: 'number' },
      { trait_type: 'current sprint', value: horse.currentSprint, display_type: 'number' },
      { trait_type: 'current speed', value: horse.currentSpeed, display_type: 'number' },

      { trait_type: 'energy', value: horse.currentEnergy, display_type: 'number' },
      { trait_type: 'max energy', value: horse.maxEnergy, display_type: 'number' },

      { trait_type: 'gen', value: horse.gen, display_type: 'number' },
      { trait_type: 'trait slots unlocked', value: horse.traitSlotsUnlocked, display_type: 'number' },
    ];

    // Encode per-slot traits: "Trait Slot 1" => "Racecraft (Rare)"
    for (const t of horse.traits) {
      attrs.push({
        trait_type: t.trait.name,   // e.g., "Racecraft"
        value: this.prettyTier(t.tier), // "Rare"
      });
    }

    return {
      name: `${horseType} Horse #${tokenId}`,
      description: `${horseType} Edition Planet Horse collectible.`,
      external_url: this.externalUrl,
      image,
      attributes: attrs,
    };
  }

  async getStableMetadata(_tokenId: string) {
    return {
      name: 'Small Stable',
      description: 'A Planet Horse small stable. Unlock the full potential of your horses!',
      external_url: this.externalUrl,
      image: 'https://planethorse.io/assets/game/stables/01-small.png',
      attributes: [
        { trait_type: 'Level', value: 1, display_type: null as unknown as undefined },
      ] as OpenSeaAttribute[],
    };
  }
}
