import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import { adminUser, isBuiltinUsername } from '../services/auth';
import { createUser, deleteUser, findUserById, findUserByUsername, listUsers, ROLES, updateUser } from '../services/users';
import { handleRouteError } from './route-utils';

// Mounted under /api/users; the auth middleware already restricts it to administrators.
const app = new Hono();

const usernameSchema = z.string().trim().regex(/^[a-zA-Z0-9._-]{3,32}$/, 'Username must be 3-32 letters, numbers, dots, dashes or underscores');
const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(200);
const roleSchema = z.enum(ROLES);
const createSchema = z.object({ username: usernameSchema, password: passwordSchema, role: roleSchema });
const updateSchema = z.object({ role: roleSchema.optional(), password: passwordSchema.optional() })
  .refine(value => value.role || value.password, 'Nothing to update');

function validationError(c: any, error: unknown) {
  if (error instanceof ZodError) return c.json({ message: error.issues.map(issue => issue.message).join('; ') }, 400);
  return null;
}

function id(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

app.get('/', async (c) => {
  try {
    return c.json({
      builtinAdmin: { username: adminUser(), role: 'admin' },
      users: await listUsers(),
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to list users');
  }
});

app.post('/', async (c) => {
  try {
    const data = createSchema.parse(await c.req.json());
    if (isBuiltinUsername(data.username) || await findUserByUsername(data.username)) {
      return c.json({ message: 'That username is already taken' }, 409);
    }
    return c.json(await createUser(data), 201);
  } catch (error) {
    return validationError(c, error) ?? handleRouteError(c, error, 'Failed to create user');
  }
});

app.patch('/:id', async (c) => {
  try {
    const userId = id(c.req.param('id'));
    if (!userId || !await findUserById(userId)) return c.json({ message: 'User not found' }, 404);
    const data = updateSchema.parse(await c.req.json());
    return c.json(await updateUser(userId, data));
  } catch (error) {
    return validationError(c, error) ?? handleRouteError(c, error, 'Failed to update user');
  }
});

app.delete('/:id', async (c) => {
  try {
    const userId = id(c.req.param('id'));
    if (!userId || !await findUserById(userId)) return c.json({ message: 'User not found' }, 404);
    await deleteUser(userId);
    return c.body(null, 204);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to delete user');
  }
});

export default app;
