import { Controller, Get, HttpException, Inject, Injectable, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { loadReviewsConfig } from './config.js';
import { ReviewsDatabase } from './database.js';
import { fail, numericId } from './http.js';

type Movie = {
  id: number; title: string; overview: string; original_title: string; release_date: string;
  poster_path: string | null; backdrop_path: string | null; popularity: number;
  vote_average: number; vote_count: number; runtime?: number | null;
  genres?: { name: string }[];
};
type Page<T> = { results: T[]; page: number; total_results: number; total_pages: number };
type MovieDetail = Movie & {
  credits?: { cast: unknown[]; crew: unknown[] };
  videos?: { results: { key: string; name: string; type: string; site: string }[] };
  production_companies?: { name: string }[];
  production_countries?: { name: string }[];
  spoken_languages?: { name: string }[];
};
type TmdbReview = {
  author: string; content: string; id: string; created_at: string; updated_at: string; url: string;
  author_details?: { username?: string; avatar_path?: string | null; rating?: number | null };
};
type Params = Record<string, string | number | boolean | undefined>;
class MovieNotFound extends Error {}

const genreIds = new Map(Object.entries({
  action: 28, adventure: 12, animation: 16, comedy: 35, crime: 80, documentary: 99, drama: 18, family: 10751,
  fantasy: 14, history: 36, horror: 27, music: 10402, mystery: 9648, romance: 10749, 'science fiction': 878,
  'tv movie': 10770, thriller: 53, war: 10752, western: 37,
}));
const names = (items?: { name: string }[]) => (items ?? []).map((item) => item.name);
const date = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

@Injectable()
export class ReviewsCatalog {
  private readonly config = loadReviewsConfig();

  private async fetch<T>(path: string, params: Params = {}): Promise<T> {
    if (!this.config.tmdbKey) fail(500, 'An internal server error occurred');
    const url = new URL('https://api.themoviedb.org/3/' + path);
    url.searchParams.set('api_key', this.config.tmdbKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (response.status === 404) throw new MovieNotFound();
      if (!response.ok) throw new Error('TMDB response failed');
      return await response.json() as T;
    } catch (error) {
      if (error instanceof MovieNotFound) throw error;
      fail(500, 'An internal server error occurred');
    }
  }

  private image(size: string, path: string | null | undefined) {
    return path ? this.config.imageBase + '/' + size + path : null;
  }

  private summary(movie: Movie) {
    return {
      id: movie.id, title: movie.title, overview: movie.overview, release_date: movie.release_date,
      poster_url: this.image('w500', movie.poster_path), vote_average: movie.vote_average, vote_count: movie.vote_count,
    };
  }

  private card(movie: Movie) {
    return {
      ...this.summary(movie), poster_path: movie.poster_path, backdrop_path: movie.backdrop_path,
      popularity: movie.popularity, backdrop_url: this.image('w1280', movie.backdrop_path),
    };
  }

  private legacyCard(movie: Movie) {
    return {
      ...this.card(movie), backdrop_path: this.image('w1280', movie.backdrop_path),
      original_title: movie.original_title, runtime: movie.runtime ?? null, genres: names(movie.genres),
    };
  }

  private async discover(days: number) {
    const { results } = await this.fetch<Page<Movie>>('discover/movie', {
      'primary_release_date.gte': date(days), 'primary_release_date.lte': date(0),
      sort_by: 'popularity.desc', page: 1,
    });
    return results;
  }

  async landingRecent() { return (await this.discover(7)).map((movie) => this.card(movie)); }

  async popular() { return (await this.discover(28)).map((movie) => this.legacyCard(movie)); }

  async recent() {
    const { results } = await this.fetch<Page<Movie>>('movie/now_playing');
    return results.map((movie) => this.legacyCard(movie));
  }

  async meFilms() {
    const [top, current] = await Promise.all([
      this.fetch<Page<Movie>>('movie/top_rated'),
      this.fetch<Page<Movie>>('movie/now_playing'),
    ]);
    return {
      top_rated: top.results.slice(0, 7).map((movie) => this.card(movie)),
      now_playing: current.results.slice(0, 7).map((movie) => this.card(movie)),
    };
  }

  async details(query: string) {
    try {
      const id = /^\d+$/.test(query) ? query : (await this.fetch<Page<Movie>>('search/movie', { query })).results[0]?.id;
      if (!id) return null;
      const movie = await this.fetch<MovieDetail>(`movie/${id}`, { append_to_response: 'credits,videos' });
      const trailers = movie.videos?.results.filter((video) => video.type === 'Trailer' && video.site === 'YouTube') ?? [];
      const trailer = trailers.find((video) => /official/i.test(video.name)) ?? trailers[0];
      const { poster_url, ...summary } = this.summary(movie);
      return {
        ...summary, original_title: movie.original_title, runtime: movie.runtime ?? null, run_time: movie.runtime ?? 0,
        genres: names(movie.genres), poster_path: poster_url, backdrop_path: this.image('w1280', movie.backdrop_path),
        cast: movie.credits?.cast ?? [], crew: movie.credits?.crew ?? [],
        production_companies: names(movie.production_companies), production_countries: names(movie.production_countries),
        spoken_languages: names(movie.spoken_languages), trailer: trailer ? 'https://www.youtube.com/embed/' + trailer.key : null,
      };
    } catch (error) {
      if (error instanceof MovieNotFound) return null;
      throw error;
    }
  }

  async related(id: number) {
    try {
      const { results } = await this.fetch<Page<Movie>>(`movie/${id}/recommendations`);
      return results.map((movie) => this.summary(movie));
    } catch (error) {
      if (error instanceof MovieNotFound) return [];
      throw error;
    }
  }

  async tmdbReviews(id: number) {
    try {
      const reviews = await this.fetch<Page<TmdbReview> & { id: number }>(`movie/${id}/reviews`);
      return {
        ...reviews,
        results: reviews.results.map((review) => ({
          ...review,
          author_details: {
            name: review.author ?? 'Unknown', username: review.author_details?.username ?? 'Unknown',
            avatar_path: this.image('w500', review.author_details?.avatar_path),
            rating: review.author_details?.rating === undefined ? 0 : review.author_details.rating,
          },
        })),
      };
    } catch {
      return { error: 'Failed to fetch trending film from TMDB' };
    }
  }

  async search(query: string, page: number) {
    try {
      const response = await this.fetch<Page<Movie>>('search/movie', { query, page });
      return {
        results: response.results.map((movie) => ({
          ...movie, poster_url: this.image('w500', movie.poster_path), backdrop_url: this.image('w780', movie.backdrop_path),
        })),
        currentPage: page, nextPage: page * 20 < response.total_results ? page + 1 : null,
      };
    } catch (error) {
      if (error instanceof MovieNotFound) return null;
      throw error;
    }
  }

  async filter(query: Record<string, unknown>) {
    const text = (key: string) => typeof query[key] === 'string' ? query[key] : undefined;
    const number = (key: string, decimal = false) => {
      const value = text(key);
      return value && (decimal ? /^\d+(\.\d+)?$/ : /^\d+$/).test(value) ? Number(value) || undefined : undefined;
    };
    const start = number('year') ?? number('start_year');
    const end = number('year') ?? number('end_year');
    const genre = text('genre');
    const page = Math.max(1, number('page') ?? 1);
    const filters = {
      sort_by: text('sort_by') || 'popularity.desc', language: 'en-US', include_adult: false,
      'primary_release_date.gte': start ? `${start}-01-01` : undefined,
      'primary_release_date.lte': end ? `${end}-12-31` : undefined,
      with_genres: genre && /^\d+$/.test(genre) ? Number(genre) : genreIds.get(genre?.trim().toLowerCase() ?? ''),
      'vote_average.gte': number('min_rating', true), 'vote_count.gte': number('min_votes'),
      'with_runtime.gte': number('min_runtime'), 'with_runtime.lte': number('max_runtime'), with_original_language: text('language'),
    };
    const pages = await Promise.all([0, 1, 2].map((offset) =>
      this.fetch<Page<Movie>>('discover/movie', { ...filters, page: (page - 1) * 3 + 1 + offset })));
    return pages.flatMap(({ results }) => results.map((movie) => this.summary(movie)));
  }
}

@Controller('reviews')
export class ReviewsCatalogController {
  constructor(
    @Inject(ReviewsCatalog) private readonly catalog: ReviewsCatalog,
    @Inject(ReviewsDatabase) private readonly db: ReviewsDatabase,
  ) {}

  @Get('test')
  test() { return { message: 'Server is running successfully!' }; }

  @Get('readyz')
  async ready(@Res({ passthrough: true }) res: Response) {
    try {
      await this.db.query('SELECT 1 FROM reviews_sessions LIMIT 1');
      return { status: 'ready' };
    } catch {
      res.status(503);
      return { status: 'unavailable' };
    }
  }

  @Get('landing/all')
  async landing() {
    const films = await this.catalog.landingRecent();
    if (!films.length) throw new HttpException({ trending_film: null, recent_films: null, recent_reviews: null }, 404);
    const trending = films.reduce<(typeof films)[number] | null>((current, film) =>
      film.vote_count > (current?.vote_count ?? 0) ? film : current, null);
    const remaining = films.filter((film) => film.id !== trending?.id);
    return { trending_film: trending, top_6_recent_films: remaining.slice(0, 6), recent_films: remaining.slice(6) };
  }

  @Get('landing/films/recent')
  async landingRecent() { return { recent_films: await this.catalog.landingRecent() }; }

  @Get('landing/films/reviews')
  async landingReviews(@Query('film_id') id: unknown) {
    return { reviews: await this.catalog.tmdbReviews(numericId(id, 'Film ID is required')) };
  }

  private async reviews() {
    const { rows } = await this.db.query('SELECT * FROM reviews WHERE is_parent = TRUE ORDER BY like_count DESC LIMIT 30');
    return rows;
  }

  @Get('films/all')
  async all() {
    const [popular, reviewed] = await Promise.all([this.catalog.popular(), this.reviews()]);
    if (!popular.length && !reviewed.length) fail(404, 'No films found', 'message');
    return { popular_films: popular.slice(0, 10), reviewed_films: reviewed };
  }

  @Get('films/popular')
  async popular() {
    const films = await this.catalog.popular();
    if (!films.length) fail(404, 'No popular films found', 'message');
    return { popular_films: films };
  }

  @Get('films/recent')
  async recent() {
    const films = await this.catalog.recent();
    if (!films.length) fail(404, 'No recent films found', 'message');
    return { recent_films: films };
  }

  @Get('films/reviewed')
  async reviewed() {
    const films = await this.reviews();
    if (!films.length) fail(404, 'No reviewed films found', 'message');
    return { reviewed_films: films };
  }

  @Get('films/filter')
  async filter(@Query() query: Record<string, unknown>) { return { filtered_films: await this.catalog.filter(query) }; }

  @Get('search/title/:title')
  async search(
    @Param('title') title: string,
    @Query('page') page: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = typeof page === 'string' && /^-?\d+$/.test(page) ? Number(page) : 1;
    const results = await this.catalog.search(title, parsed);
    if (!results) res.status(204);
    return results;
  }
}
