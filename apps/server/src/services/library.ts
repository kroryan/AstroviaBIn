import path from 'node:path';
import type { LibraryAsset } from '@shared/types';

export function libraryStorageDirectory(): string {
  return path.resolve(process.env.LIBRARY_STORAGE_DIR || (process.env.NODE_ENV === 'production'
    ? '/app/library'
    : path.join(process.cwd(), 'data', 'library')));
}

export function resolveLibraryAssetPath(asset: Pick<LibraryAsset, 'relativePath'>): string {
  const root = libraryStorageDirectory();
  const resolved = path.resolve(root, asset.relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Invalid local library asset path');
  return resolved;
}
