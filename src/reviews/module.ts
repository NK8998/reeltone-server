import { Module } from '@nestjs/common';
import { ReviewsAuth, ReviewsAuthController } from './auth.js';
import { ReviewsCatalog, ReviewsCatalogController } from './catalog.js';
import { ReviewsMeController, ReviewsMembersController } from './community.js';
import { ReviewsDatabase } from './database.js';
import { ReviewsFilmController } from './film.js';

@Module({
  controllers: [ReviewsAuthController, ReviewsCatalogController, ReviewsFilmController, ReviewsMeController, ReviewsMembersController],
  providers: [ReviewsAuth, ReviewsCatalog, { provide: ReviewsDatabase, useFactory: () => new ReviewsDatabase() }],
})
export class ReviewsModule {}
