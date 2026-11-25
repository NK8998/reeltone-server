import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ReviewsAuth } from './auth.js';
import { ReviewsCatalog } from './catalog.js';
import { lockInteraction, ReviewsDatabase } from './database.js';
import { fail, requiredText } from './http.js';

@Controller('reviews/members')
export class ReviewsMembersController {
  constructor(
    @Inject(ReviewsAuth) private readonly auth: ReviewsAuth,
    @Inject(ReviewsDatabase) private readonly db: ReviewsDatabase,
  ) {}

  private async members(user: string | null) {
    const { rows } = await this.db.query(`SELECT m.id, m.user_id, m.username, m.pfp_url, m.joined_at,
      EXISTS(SELECT 1 FROM followers f WHERE f.followed_id = m.user_id AND f.follower_id = $1) AS is_following
      FROM members m`, [user]);
    return rows;
  }

  private async related(user: string, direction: 'followers' | 'following') {
    const member = direction === 'followers' ? 'follower_id' : 'followed_id';
    const target = direction === 'followers' ? 'followed_id' : 'follower_id';
    const { rows } = await this.db.query(`SELECT m.id, m.user_id, m.username, m.pfp_url, m.joined_at,
      EXISTS(SELECT 1 FROM followers r WHERE r.follower_id = $1 AND r.followed_id = m.user_id) AS is_following
      FROM followers f JOIN members m ON f.${member} = m.user_id WHERE f.${target} = $1`, [user]);
    return rows;
  }

  @Get('all')
  async all(@Req() req: Request) {
    const viewer = await this.auth.viewer(req);
    if (!viewer) return { members: await this.members(null), followers: [], following: [] };
    const [members, followers, following] = await Promise.all([
      this.members(viewer.id), this.related(viewer.id, 'followers'), this.related(viewer.id, 'following'),
    ]);
    return { members, followers, following };
  }

  @Post('discover')
  @HttpCode(200)
  async discover() { return { members: await this.members(null) }; }

  @Post('follows/add')
  async follow(@Req() req: Request, @Body('followed_id') followedId: unknown) {
    const { id: follower } = await this.auth.requireViewer(req);
    const followed = requiredText(followedId, 'Missing follower_id or followed_id.');
    await this.db.transaction(async (db) => {
      await lockInteraction(db, 'follow', follower, followed);
      const removed = await db.query('DELETE FROM followers WHERE follower_id = $1 AND followed_id = $2', [follower, followed]);
      if (!removed.rowCount) {
        await db.query('INSERT INTO followers (follower_id, followed_id) VALUES ($1, $2)', [follower, followed]);
      }
    });
    return { message: 'Following relationship added.' };
  }

  @Post('follows/followers')
  @HttpCode(200)
  async followers(@Body('user_id') id: unknown) {
    return { followers: await this.related(requiredText(id, 'Missing user_id.'), 'followers') };
  }

  @Post('follows/following')
  @HttpCode(200)
  async following(@Body('user_id') id: unknown) {
    return { following: await this.related(requiredText(id, 'Missing user_id.'), 'following') };
  }
}

@Controller('reviews/me')
export class ReviewsMeController {
  constructor(
    @Inject(ReviewsAuth) private readonly auth: ReviewsAuth,
    @Inject(ReviewsDatabase) private readonly db: ReviewsDatabase,
    @Inject(ReviewsCatalog) private readonly catalog: ReviewsCatalog,
  ) {}

  private async collections(user: string) {
    const [watched, watchlist] = await Promise.all([
      this.db.query(`SELECT w.film_id, w.film_title, w.film_poster, w.watched_at,
        EXISTS(SELECT 1 FROM watchlist l WHERE l.user_id = w.user_id AND l.film_id = w.film_id) AS rewatching
        FROM watched w WHERE w.user_id = $1 ORDER BY w.watched_at DESC`, [user]),
      this.db.query(`SELECT l.film_id, l.film_title, l.film_poster, l.added_at,
        EXISTS(SELECT 1 FROM watched w WHERE w.user_id = l.user_id AND w.film_id = l.film_id) AS rewatching
        FROM watchlist l WHERE l.user_id = $1 ORDER BY l.added_at DESC`, [user]),
    ]);
    return { watched: watched.rows, watchlist: watchlist.rows };
  }

  private async activity(user: string) {
    const { rows } = await this.db.query(`SELECT r.* FROM reviews r
      JOIN followers f ON r.user_id = f.follower_id WHERE f.followed_id = $1`, [user]);
    return rows;
  }

  private async topReviews() {
    const { rows } = await this.db.query('SELECT * FROM reviews ORDER BY like_count DESC LIMIT 30');
    return rows;
  }

  @Get('all')
  async all(@Req() req: Request) {
    const { id } = await this.auth.requireViewer(req);
    const [films, activity, userContent, reviews] = await Promise.all([
      this.catalog.meFilms(), this.activity(id), this.collections(id), this.topReviews(),
    ]);
    if (!activity.length && !films.top_rated.length && !films.now_playing.length && !reviews.length) {
      fail(404, 'No data found', 'message');
    }
    return { ...films, friends_activity: activity, reviews, user_content: userContent };
  }

  @Get('content')
  async content(@Req() req: Request) {
    const { id } = await this.auth.requireViewer(req);
    return { friends_activity: await this.collections(id) };
  }

  @Get('films')
  async films(@Req() req: Request) {
    await this.auth.requireViewer(req);
    return this.catalog.meFilms();
  }

  @Get('friends')
  async friends(@Req() req: Request) {
    const { id } = await this.auth.requireViewer(req);
    const activity = await this.activity(id);
    if (!activity.length) fail(404, 'No friends activity found', 'message');
    return { friends_activity: activity };
  }

  @Get('reviews')
  async reviews(@Req() req: Request) {
    await this.auth.requireViewer(req);
    const reviews = await this.topReviews();
    if (!reviews.length) fail(404, 'No reviews found', 'message');
    return { reviews };
  }
}
