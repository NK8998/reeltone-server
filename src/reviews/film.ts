import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ReviewsAuth } from './auth.js';
import { ReviewsCatalog } from './catalog.js';
import { lockInteraction, ReviewsDatabase } from './database.js';
import { fail, numericId, requiredText } from './http.js';

type BodyData = Record<string, unknown>;
type FilmFlags = { has_liked: boolean; in_watchlist: boolean; watched: boolean };

const optionalText = (value: unknown, message: string) => {
  if (value == null) return null;
  if (typeof value !== 'string') fail(400, message);
  return value;
};

function ratingValue(value: unknown) {
  if (value == null) return null;
  const rating = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 10) {
    fail(400, 'Rating must be between 0 and 10.');
  }
  return rating;
}

@Controller('reviews/film')
export class ReviewsFilmController {
  constructor(
    @Inject(ReviewsAuth) private readonly auth: ReviewsAuth,
    @Inject(ReviewsDatabase) private readonly db: ReviewsDatabase,
    @Inject(ReviewsCatalog) private readonly catalog: ReviewsCatalog,
  ) {}

  private async filmReviews(film: number) {
    const { rows } = await this.db.query(
      'SELECT * FROM reviews WHERE film_id = $1 ORDER BY created_at DESC LIMIT 30', [film],
    );
    return rows;
  }

  private async flags(user: string | null, film: number) {
    if (!user) return { has_liked: false, in_watchlist: false, watched: false };
    const { rows } = await this.db.query<FilmFlags>(`SELECT
      EXISTS(SELECT 1 FROM film_likes WHERE user_id = $1 AND film_id = $2) AS has_liked,
      EXISTS(SELECT 1 FROM watchlist WHERE user_id = $1 AND film_id = $2) AS in_watchlist,
      EXISTS(SELECT 1 FROM watched WHERE user_id = $1 AND film_id = $2) AS watched`, [user, film]);
    return rows[0];
  }

  @Get('all')
  async all(@Req() req: Request, @Query('query') query: unknown) {
    const essential = await this.catalog.details(requiredText(query, 'query parameter is required'));
    if (!essential) fail(404, 'Film not found');
    if (!essential.id) fail(404, 'Film ID not found in the response');
    const [reviews, flags] = await Promise.all([
      this.filmReviews(essential.id),
      this.auth.viewer(req).then((viewer) => this.flags(viewer?.id ?? null, essential.id)),
    ]);
    return { essential_data: essential, reviews, user_flags: flags };
  }

  @Get('essential')
  async essential(@Query('query') query: unknown) {
    const result = await this.catalog.details(requiredText(query, 'query is required'));
    if (!result) fail(404, 'Film not found');
    return result;
  }

  @Get('related')
  async related(@Query('film_id') id: unknown) {
    return { related_films: await this.catalog.related(numericId(id, 'film_id is required')) };
  }

  @Get('reviews/get')
  async getReviews(@Query('film_id') id: unknown) {
    const reviews = await this.filmReviews(numericId(id, 'film_id is required'));
    if (!reviews.length) fail(404, 'No reviews found for this film', 'message');
    return { reviews };
  }

  @Post('reviews/add')
  async addReview(@Req() req: Request, @Body() body: BodyData | undefined) {
    const viewer = await this.auth.requireViewer(req);
    const film = numericId(body?.film_id, 'Missing required fields.');
    const title = requiredText(body?.film_title, 'Missing required fields.');
    const poster = optionalText(body?.film_poster, 'Invalid film_poster.');
    const rating = ratingValue(body?.rating);
    const content = optionalText(body?.review_text, 'Invalid review_text.');
    const isParent = body?.is_parent === undefined ? true : Boolean(body.is_parent);
    const parent = body?.parent_id == null ? null : numericId(body.parent_id, 'Invalid parent_id.');
    const { rows } = await this.db.query(`INSERT INTO reviews
      (user_id, username, pfp_url, film_id, film_title, film_poster, rating, review_text, is_parent, parent_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`,
    [viewer.id, viewer.username, viewer.imageUrl, film, title, poster, rating, content, isParent, parent]);
    return { message: 'Review added successfully.', film_data: rows[0] };
  }

  @Post('reviews/edit')
  async editReview(@Req() req: Request, @Body() body: BodyData | undefined) {
    const { id: user } = await this.auth.requireViewer(req);
    const missing = 'Missing user_id, review_id, new_content, or rating.';
    const id = numericId(body?.review_id, missing);
    const content = requiredText(body?.new_content, missing);
    const rating = ratingValue(body?.rating);
    if (rating === null) fail(400, missing);
    const { rows } = await this.db.query(`UPDATE reviews SET review_text = $1, updated_at = now(), rating = $2
      WHERE user_id = $3 AND id = $4 RETURNING id, user_id, review_text, rating, updated_at`, [content, rating, user, id]);
    if (!rows[0]) return { message: 'Review not found or user not authorized.', film_data: {} };
    return { message: 'Review updated successfully.', film_data: rows[0] };
  }

  @Post('reviews/delete')
  async deleteReview(@Req() req: Request, @Body() body: BodyData | undefined) {
    const { id: user } = await this.auth.requireViewer(req);
    const id = numericId(body?.review_id, 'Missing user_id or review_id.');
    const admin = this.auth.config.adminIds.has(user);
    const { rowCount } = await this.db.query('DELETE FROM reviews WHERE id = $1 AND ($2 OR user_id = $3)', [id, admin, user]);
    const message = !rowCount ? 'Review not found.' : admin ? 'Review deleted by admin.' : 'Review deleted.';
    return { message: { message } };
  }

  private async toggleLike(kind: 'review' | 'film', user: string, id: number) {
    const table = kind === 'review' ? 'review_likes' : 'film_likes';
    const field = kind === 'review' ? 'review_id' : 'film_id';
    const added = await this.db.transaction(async (db) => {
      await lockInteraction(db, kind + '-like', user, id);
      const removed = await db.query(`DELETE FROM ${table} WHERE user_id = $1 AND ${field} = $2`, [user, id]);
      if (removed.rowCount) return false;
      await db.query(`INSERT INTO ${table} (user_id, ${field}) VALUES ($1, $2)`, [user, id]);
      return true;
    });
    const message = added ? (kind === 'review' ? 'Review liked.' : 'Film liked.') : 'Like removed.';
    return { message: { message } };
  }

  @Post('reviews/like')
  async likeReview(@Req() req: Request, @Body() body: BodyData | undefined) {
    const { id: user } = await this.auth.requireViewer(req);
    return this.toggleLike('review', user, numericId(body?.review_id, 'Missing user_id or review_id.'));
  }

  @Post('like')
  async likeFilm(@Req() req: Request, @Body() body: BodyData | undefined) {
    const { id: user } = await this.auth.requireViewer(req);
    return this.toggleLike('film', user, numericId(body?.film_id, 'Missing user_id or film_id.'));
  }

  private async toggleList(table: 'watchlist' | 'watched', req: Request, body: BodyData | undefined) {
    const { id: user } = await this.auth.requireViewer(req);
    const missing = 'Missing user_id, film_id, film_title, or film_poster.';
    const film = numericId(body?.film_id, missing);
    const title = requiredText(body?.film_title, missing);
    const poster = requiredText(body?.film_poster, missing);
    return this.db.transaction(async (db) => {
      await lockInteraction(db, table, user, film);
      const removed = await db.query(`DELETE FROM ${table} WHERE user_id = $1 AND film_id = $2`, [user, film]);
      if (removed.rowCount) return false;
      await db.query(`INSERT INTO ${table} (user_id, film_id, film_title, film_poster) VALUES ($1, $2, $3, $4)`,
        [user, film, title, poster]);
      return true;
    });
  }

  @Post('watchlist')
  async watchlist(@Req() req: Request, @Body() body: BodyData | undefined) {
    const added = await this.toggleList('watchlist', req, body);
    return {
      message: {
        message: added ? 'Film added to watchlist.' : 'Film removed from watchlist.',
        is_in_watchlist: added,
      },
    };
  }

  @Post('watched')
  async watched(@Req() req: Request, @Body() body: BodyData | undefined) {
    const added = await this.toggleList('watched', req, body);
    return { message: { message: added ? 'Film added to watched list.' : 'Film removed from watched list.' } };
  }
}
