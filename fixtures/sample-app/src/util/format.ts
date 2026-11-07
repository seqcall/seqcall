import type { User } from '../domain/user';

export function formatName(user: User): string {
  return `${slugify(user.name)} <${user.email}>`;
}

export const slugify = (s: string): string => s.toLowerCase().replace(/\s+/g, '-');

export const shout = function (s: string): string {
  return s.toUpperCase();
};
