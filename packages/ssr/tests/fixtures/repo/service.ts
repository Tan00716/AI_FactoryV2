export class UserService {
  private db: unknown;

  constructor(db: unknown) {
    this.db = db;
  }

  public async getUser(id: number): Promise<unknown> {
    const row: Record<string, unknown> = await this.query(id);
    return row;
  }

  private async query(id: number): Promise<Record<string, unknown>> {
    return { id };
  }

  static create(db: unknown): UserService {
    return new UserService(db);
  }

  async refreshAll(): Promise<void> {
    const items: number[] = [1, 2, 3];
    for (const id of items) {
      await this.getUser(id);
    }
  }
}

export function topLevelHelper(name: string): string {
  const greeting: string = `hello ${name}`;
  return greeting;
}

const MAX_RETRIES: number = 3;
let attemptCount = 0;

export async function runWithRetry(label: string): Promise<boolean> {
  let count = 0;
  while (count < MAX_RETRIES) {
    attemptCount++;
    count++;
    if (await tryOnce(label)) return true;
  }
  return false;
}

async function tryOnce(label: string): Promise<boolean> {
  return label.length > 0;
}

export interface UserRow {
  id: number;
  name: string;
}
