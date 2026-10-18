import { storage } from './storage';

export interface AppConfig {
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

class ConfigService {
  private config: AppConfig | null = null;

  async getConfig(): Promise<AppConfig> {
    if (this.config) {
      return this.config;
    }

    // Try to get admin settings first (from storage)
    const adminSettings = await this.getAdminSettings();
    
    // Fall back to hardcoded defaults if admin settings are not available
    const defaultConfig = this.getHardcodedDefaults();
    
    // Merge with admin settings taking priority over defaults
    this.config = {
      astrometry: {
        enabled: adminSettings.astrometry?.enabled ?? defaultConfig.astrometry.enabled,
        autoEnabled: adminSettings.astrometry?.autoEnabled ?? defaultConfig.astrometry.autoEnabled,
        checkInterval: adminSettings.astrometry?.checkInterval ?? defaultConfig.astrometry.checkInterval,
        pollInterval: adminSettings.astrometry?.pollInterval ?? defaultConfig.astrometry.pollInterval,
        maxConcurrent: adminSettings.astrometry?.maxConcurrent ?? defaultConfig.astrometry.maxConcurrent,
        autoResubmit: adminSettings.astrometry?.autoResubmit ?? defaultConfig.astrometry.autoResubmit,
      },
      sidecar: {
        enabled: adminSettings.sidecar?.enabled ?? defaultConfig.sidecar.enabled,
        outputPath: process.env.XMP_SIDECAR_PATH || adminSettings.sidecar?.outputPath || defaultConfig.sidecar.outputPath,
        organizeByDate: adminSettings.sidecar?.organizeByDate ?? defaultConfig.sidecar.organizeByDate,
      },
      app: {
        debugMode: adminSettings.app?.debugMode ?? defaultConfig.app.debugMode,
      },
    };

    return this.config;
  }

  private async getAdminSettings(): Promise<Partial<AppConfig>> {
    try {
      const settings = await storage.getAdminSettings();
      return settings;
    } catch (error) {
      console.warn('Failed to load admin settings:', error);
      return {};
    }
  }

  private getHardcodedDefaults(): AppConfig {
    // Defaults for a private, local Astrometry.net installation.
    return {
      astrometry: {
        enabled: true,
        autoEnabled: false,  // Disabled by default
        checkInterval: 30,  // Reasonable default (seconds)
        pollInterval: 5,  // Reasonable default (seconds)
        maxConcurrent: 3,  // Reasonable default
        autoResubmit: false,  // Disabled by default
      },
      sidecar: {
        enabled: true,  // Generate XMP sidecars by default
        outputPath: './sidecars',  // Default path, overridden by XMP_SIDECAR_PATH env
        organizeByDate: true,  // Organize into yyyy-mm subdirectories
      },
      app: {
        debugMode: false,  // Disabled by default
      },
    };
  }

  async updateConfig(newConfig: Partial<AppConfig>): Promise<void> {
    // Update admin settings in storage
    await this.saveAdminSettings(newConfig);
    
    // Clear cached config so it will be reloaded
    this.config = null;
  }

  private async saveAdminSettings(config: Partial<AppConfig>): Promise<void> {
    try {
      await storage.updateAdminSettings(config);
    } catch (error) {
      console.error('Failed to save admin settings:', error);
      throw error;
    }
  }

  async getAstrometryConfig() {
    const config = await this.getConfig();
    return config.astrometry;
  }

  async getSidecarConfig() {
    const config = await this.getConfig();
    return config.sidecar;
  }

  async getAppConfig() {
    const config = await this.getConfig();
    return config.app;
  }
}

export const configService = new ConfigService();
