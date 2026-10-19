import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Settings,
  Save,
  Loader2,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { Notification } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { NotificationsSection } from '@/components/admin/notifications-section';
import { AstrometrySection } from '@/components/admin/astrometry-section';
import { SidecarSection } from '@/components/admin/sidecar-section';
import { CatalogSection } from '@/components/admin/catalog-section';
import { AppSettingsSection } from '@/components/admin/app-settings-section';
import { DatabaseSection } from '@/components/admin/database-section';
import { AboutSection } from '@/components/admin/about-section';
import { UsersSection } from '@/components/admin/users-section';
import { useCurrentUser } from '@/hooks/use-current-user';

export interface AdminSettings {
  astrometry: {
    enabled: boolean;
    autoEnabled: boolean;
    checkInterval: number;
    pollInterval: number;
    maxConcurrent: number;
    autoResubmit: boolean;
  };
  sidecar: {
    enabled: boolean;
    outputPath: string;
    organizeByDate: boolean;
  };
  app: {
    debugMode: boolean;
  };
}

export default function AdminPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<AdminSettings>({
    astrometry: {
      enabled: true,
      autoEnabled: false,
      checkInterval: 30,
      pollInterval: 5,
      maxConcurrent: 3,
      autoResubmit: false,
    },
    sidecar: {
      enabled: true,
      outputPath: './sidecars',
      organizeByDate: true,
    },
    app: {
      debugMode: false,
    },
  });
  const [loading, setLoading] = useState(false);
  const [astrometryTestStatus, setAstrometryTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [astrometryTestMessage, setAstrometryTestMessage] = useState('');
  const [showAllNotifications, setShowAllNotifications] = useState(false);
  const { user } = useCurrentUser();

  // Use React Query for notifications for consistent state across Header and Admin
  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["/api/notifications"],
  });

  // Catalog status
  const { data: catalogStatus, refetch: refetchCatalogStatus } = useQuery<{ count: number; lastUpdated: string | null; commitSha: string | null }>({
    queryKey: ["/api/catalog/status"],
  });

  // Load settings on component mount
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const response = await fetch('/api/admin/settings');
      if (response.ok) {
        const data = await response.json();
        setSettings(prev => ({
          ...prev,
          ...data,
          sidecar: { ...prev.sidecar, ...data.sidecar },
        }));
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
      toast({
        title: "Error",
        description: "Failed to load settings",
        variant: "destructive",
      });
    }
  };

  const saveSettings = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(settings),
      });

      if (response.ok) {
        toast({
          title: "Success",
          description: "Settings saved successfully",
        });
      } else {
        throw new Error('Failed to save settings');
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast({
        title: "Error",
        description: "Failed to save settings",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const testAstrometryConnection = async () => {
    setAstrometryTestStatus('testing');
    setAstrometryTestMessage('');

    try {
      const response = await fetch('/api/test-astrometry-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      const data = await response.json();

      if (data.success) {
        setAstrometryTestStatus('success');
        setAstrometryTestMessage(data.message);
      } else {
        setAstrometryTestStatus('error');
        setAstrometryTestMessage(data.message);
      }
    } catch (error) {
      setAstrometryTestStatus('error');
      setAstrometryTestMessage('Connection test failed');
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center space-x-4 mb-8">
          <Settings className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">Admin Settings</h1>
            <p className="text-muted-foreground">Configure your AstroviaBin server</p>
          </div>
        </div>

        {user && user.role !== 'admin' ? (
          <p className="text-muted-foreground">Signed in as <span className="font-medium text-foreground">{user.username}</span> ({user.role}). Only administrators can change settings and accounts.</p>
        ) : (<>

        <NotificationsSection
          notifications={notifications}
          showAllNotifications={showAllNotifications}
          setShowAllNotifications={setShowAllNotifications}
        />

        <UsersSection />

        <form onSubmit={(e) => { e.preventDefault(); saveSettings(); }}>
          <AstrometrySection
            settings={settings}
            setSettings={setSettings}
            astrometryTestStatus={astrometryTestStatus}
            astrometryTestMessage={astrometryTestMessage}
            testAstrometryConnection={testAstrometryConnection}
          />

          <SidecarSection
            settings={settings}
            setSettings={setSettings}
          />

          <CatalogSection
            catalogStatus={catalogStatus}
            refetchCatalogStatus={refetchCatalogStatus}
          />

          <DatabaseSection />

          <AppSettingsSection
            settings={settings}
            setSettings={setSettings}
          />

          <AboutSection />

          {/* Save Button */}
          <div className="flex justify-end">
            <Button type="submit" className="sky-button-primary" disabled={loading}>
              <Save className="mr-2 h-4 w-4" />
              {loading ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </form>
        </>)}
      </div>
    </div>
  );
}
