// src/auth/auth.service.ts
import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { JwtService }    from '@nestjs/jwt'
import { randomBytes }   from 'crypto'
import { verifyMessage } from 'ethers'
import { UserService }    from '../user/user.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private userService: UserService
  ) {}

  async createAuthMessage(address: string) {
    const nonce = randomBytes(16).toString('hex')
    await this.prisma.nonce.create({
      data: { address: address.toLowerCase(), nonce, expiresAt: new Date(Date.now() + 10*60*1000) }
    })

    const domain   = process.env.SITE_DOMAIN || 'localhost'
    const uri      = process.env.SITE_URL    || 'http://localhost:3000'
    const issuedAt = new Date().toISOString()

    return `${domain} wants you to sign in with your Ronin account:
${address}

Sign-In With Ethereum Message
URI: ${uri}
Version: 1
Chain ID: 0x507
Nonce: ${nonce}
Issued At: ${issuedAt}`
  }

  async verifyAndSign(message: string, signature: string) {
    const lines      = message.split('\n')
    const addressLine= lines[1].trim()
    const domainLine = lines[0].split(' ')[0]
    const uriLine    = lines.find(l => l.startsWith('URI: '))!.slice(5)
    const versionLine= lines.find(l => l.startsWith('Version: '))!.slice(9)
    const chainLine  = lines.find(l => l.startsWith('Chain ID: '))!.slice(10)
    const nonceLine  = lines.find(l => l.startsWith('Nonce: '))!.slice(7)

    if (domainLine  !== (process.env.SITE_DOMAIN||'localhost'))  
      throw new BadRequestException('Invalid domain')
    if (uriLine     !== (process.env.SITE_URL   ||'http://localhost:3000')) 
      throw new BadRequestException('Invalid URI')
    if (versionLine !== '1')                             
      throw new BadRequestException('Invalid version')
    if (chainLine.toLowerCase() !== '0x507')             
      throw new BadRequestException('Invalid chain')

    const record = await this.prisma.nonce.findUnique({ where: { nonce: nonceLine } })
    if (!record || record.address !== addressLine.toLowerCase())
      throw new BadRequestException('Invalid or unknown nonce')
    if (record.expiresAt < new Date())
      throw new BadRequestException('Nonce expired')

    const recovered = verifyMessage(message, signature)
    if (recovered.toLowerCase() !== addressLine.toLowerCase())
      throw new BadRequestException('Signature mismatch')

    await this.prisma.nonce.delete({ where: { nonce: nonceLine } })

    const walletAddress = addressLine.toLowerCase();
    await this.userService.findOrCreateByAddress(walletAddress);

    return this.jwt.sign(
      { address: addressLine.toLowerCase() },
      { subject: addressLine.toLowerCase(), expiresIn: '1h' }
    )
  }
}
