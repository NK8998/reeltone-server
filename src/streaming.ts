import { readFileSync } from 'node:fs';
import { Controller, Get, Module, NotFoundException, Param } from '@nestjs/common';
import { parse } from 'csv-parse/sync';

type VideoRow = {
  video_id: string;
  created_at: string;
  preferred_thumbnail_url: string;
  possible_thumbnail_urls: string;
  resolutions: string;
  mpd_url?: string;
  manifest_url?: string;
};

const csv = new URL('../streaming/mock_data.csv', import.meta.url);
const rows = parse(readFileSync(csv, 'utf8'), { columns: true, bom: true, skip_empty_lines: true }) as VideoRow[];
const videos = new Map(rows.map((row) => {
  const video = {
    id: row.video_id,
    addedAt: new Date(row.created_at.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString(),
    artwork: row.preferred_thumbnail_url === 'null'
      ? Object.values(JSON.parse(row.possible_thumbnail_urls) as Record<string, string>)[0]
      : row.preferred_thumbnail_url,
    encodings: JSON.parse(row.resolutions) as { width: number; height: number; tag: string }[],
    manifestUrl: row.mpd_url?.trim() || row.manifest_url?.trim() || null,
  };
  return [video.id, video];
}));

@Controller('api/stream/videos')
class StreamingController {
  @Get()
  list() {
    return Array.from(videos.values());
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const video = videos.get(id);
    if (!video) throw new NotFoundException('Video not found');
    return video;
  }
}

@Module({ controllers: [StreamingController] })
export class StreamingModule {}
