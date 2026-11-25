import { Module } from '@nestjs/common';
import { Accounts, Mailer } from './accounts.js';
import { Database } from './db.js';
import { InteractionController } from './interactions.js';
import { OidcService } from './oidc.js';
import { SocialLogin } from './social.js';

@Module({
  controllers: [InteractionController],
  providers: [Database, OidcService, Accounts, Mailer, SocialLogin],
  exports: [OidcService],
})
export class AuthModule {}
