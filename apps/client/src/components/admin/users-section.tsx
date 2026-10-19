import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Shield, Trash2, UserPlus, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import type { Role } from '@/hooks/use-current-user';

interface ManagedUser {
  id: number;
  username: string;
  role: Role;
  createdAt: string | null;
}

const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin — everything, including settings and users',
  editor: 'Editor — upload, edit, solve, catalogs',
  viewer: 'Viewer — read only',
};

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Request failed';
  const text = error.message.replace(/^\d+:\s*/, '');
  try { return JSON.parse(text).message || text; } catch { return text; }
}

function RoleSelect({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
  return (
    <Select value={value} onValueChange={next => onChange(next as Role)}>
      <SelectTrigger className="w-[130px] h-8"><SelectValue /></SelectTrigger>
      <SelectContent>
        {(Object.keys(ROLE_LABELS) as Role[]).map(role => <SelectItem key={role} value={role}>{role}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function UsersSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [resetFor, setResetFor] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const { data } = useQuery<{ builtinAdmin: { username: string }; users: ManagedUser[] }>({ queryKey: ['/api/users'] });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['/api/users'] });
  const fail = (error: unknown) => toast({ title: 'Error', description: errorMessage(error), variant: 'destructive' });

  const create = useMutation({
    mutationFn: async () => apiRequest('POST', '/api/users', { username: username.trim(), password, role }),
    onSuccess: () => { setUsername(''); setPassword(''); setRole('viewer'); refresh(); toast({ title: 'User created' }); },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: async ({ id, changes }: { id: number; changes: { role?: Role; password?: string } }) => apiRequest('PATCH', `/api/users/${id}`, changes),
    onSuccess: (_response, variables) => {
      refresh();
      if (variables.changes.password) { setResetFor(null); setNewPassword(''); toast({ title: 'Password changed', description: 'Their existing sessions were signed out.' }); }
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest('DELETE', `/api/users/${id}`),
    onSuccess: refresh,
    onError: fail,
  });

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" /> Users & roles</CardTitle>
        <CardDescription>Create accounts and decide what each person can do. Role changes apply immediately; password changes and deletions sign the account out.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ul className="text-xs text-muted-foreground space-y-0.5">
          {(Object.keys(ROLE_LABELS) as Role[]).map(item => <li key={item}><span className="font-medium text-foreground">{item}</span>: {ROLE_LABELS[item].split('— ')[1]}</li>)}
        </ul>

        <div className="divide-y divide-border rounded-md border border-border">
          {data?.builtinAdmin && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" />
                <span className="font-medium">{data.builtinAdmin.username}</span>
                <Badge variant="secondary">admin</Badge>
                <Badge variant="outline">built-in</Badge>
              </div>
              <span className="text-xs text-muted-foreground">Set with SIDEREAL_ADMIN_USER / SIDEREAL_ADMIN_PASSWORD on the server</span>
            </div>
          )}
          {data?.users.map(user => (
            <div key={user.id} className="p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{user.username}</span>
                <div className="flex items-center gap-2">
                  <RoleSelect value={user.role} onChange={next => update.mutate({ id: user.id, changes: { role: next } })} />
                  <Button size="sm" variant="ghost" title="Change password" onClick={() => { setResetFor(resetFor === user.id ? null : user.id); setNewPassword(''); }}>
                    <KeyRound className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="hover:text-red-400" title="Delete user"
                    onClick={() => { if (window.confirm(`Delete ${user.username}? Their photos and edits stay in Sidereal.`)) remove.mutate(user.id); }}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {resetFor === user.id && (
                <form className="flex gap-2" onSubmit={event => { event.preventDefault(); update.mutate({ id: user.id, changes: { password: newPassword } }); }}>
                  <Input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="New password (min. 8 characters)" className="h-8" />
                  <Button size="sm" type="submit" disabled={newPassword.length < 8}>Save</Button>
                </form>
              )}
            </div>
          ))}
          {data && data.users.length === 0 && <p className="p-3 text-xs text-muted-foreground">No additional users yet.</p>}
        </div>

        <form className="flex flex-col sm:flex-row gap-2" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
          <Input value={username} onChange={event => setUsername(event.target.value)} placeholder="Username" autoComplete="off" className="h-9" />
          <Input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Password (min. 8)" autoComplete="new-password" className="h-9" />
          <RoleSelect value={role} onChange={setRole} />
          <Button type="submit" disabled={!username.trim() || password.length < 8 || create.isPending}>
            <UserPlus className="h-4 w-4 mr-2" /> Create user
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
