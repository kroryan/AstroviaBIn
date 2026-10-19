import { useState } from 'react';
import { Clock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime, setTimeZoneMode, timeZoneMode, type TimeZoneMode } from '@/lib/datetime';

/** Per-browser display preferences (any role). */
export function DisplaySection() {
  const [mode, setMode] = useState<TimeZoneMode>(timeZoneMode);
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const choose = (next: TimeZoneMode) => {
    setTimeZoneMode(next);
    setMode(next);
    // Every date on the page is formatted at render time; reload so all of them switch together.
    window.location.reload();
  };
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5" /> Dates and times</CardTitle>
        <CardDescription>Shown in UTC by default (FITS DATE-OBS and observing logs use UTC). Saved in this browser only.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {([['utc', 'UTC'], ['local', `Local time (${local})`]] as const).map(([value, label]) => (
          <label key={value} className="flex cursor-pointer items-center gap-2">
            <input type="radio" name="time-zone" checked={mode === value} onChange={() => choose(value)} />
            {label}
          </label>
        ))}
        <p className="font-mono text-xs text-muted-foreground">Now: {formatDateTime(new Date())}</p>
      </CardContent>
    </Card>
  );
}
