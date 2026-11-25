import { HttpException } from '@nestjs/common';

export function fail(status: number, text: string, key = 'error'): never {
  throw new HttpException({ [key]: text }, status);
}

export function requiredText(value: unknown, message: string) {
  if (typeof value !== 'string' || !value.trim()) fail(400, message);
  return value;
}

export function numericId(value: unknown, message: string) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) fail(400, message);
  return id;
}
