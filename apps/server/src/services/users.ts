import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number }) => Promise<Buffer>;

export const ROLES = ['admin', 'editor', 'viewer'] as const;
export type Role = typeof ROLES[number];

export interface UserRecord {
  id: number;
  username: string;
  passwordHash: string;
  role: Role;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

export type PublicUser = Omit<UserRecord, 'passwordHash'>;

const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Short fingerprint of the password hash: sessions carry it so a password change signs them out. */
export function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function toPublic(user: UserRecord): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

export async function listUsers(): Promise<PublicUser[]> {
  const rows = await db.select().from(schema.users).orderBy(schema.users.username).execute() as UserRecord[];
  return rows.map(toPublic);
}

export async function findUserByUsername(username: string): Promise<UserRecord | undefined> {
  const rows = await db.select().from(schema.users).where(sql`lower(${schema.users.username}) = lower(${username})`).execute() as UserRecord[];
  return rows[0];
}

export async function findUserById(id: number): Promise<UserRecord | undefined> {
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, id)).execute() as UserRecord[];
  return rows[0];
}

export async function createUser(data: { username: string; password: string; role: Role }): Promise<PublicUser> {
  const rows = await db.insert(schema.users).values({
    username: data.username,
    passwordHash: await hashPassword(data.password),
    role: data.role,
  }).returning().execute() as UserRecord[];
  return toPublic(rows[0]);
}

export async function updateUser(id: number, data: { role?: Role; password?: string }): Promise<PublicUser | undefined> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.role) updates.role = data.role;
  if (data.password) updates.passwordHash = await hashPassword(data.password);
  const rows = await db.update(schema.users).set(updates).where(eq(schema.users.id, id)).returning().execute() as UserRecord[];
  return rows[0] ? toPublic(rows[0]) : undefined;
}

export async function deleteUser(id: number): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, id)).execute();
}
