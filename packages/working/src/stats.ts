// Read-only facts about a working store on disk, for telling whether it survived a deploy.

export interface StoreStats {
  readonly error?: string;
}

export function storeStats(_dir: string): StoreStats {
  return { error: "not implemented yet" };
}
