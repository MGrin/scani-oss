import { useEffect, useState } from 'react';
import { z } from 'zod';

// Settings schemas
export const UserSettingsSchema = z.object({
  // Profile settings
  profile: z
    .object({
      name: z.string().min(1),
      email: z.string().email(),
      avatar: z.string().optional(),
      timezone: z.string().default('UTC'),
      locale: z.string().default('en-US'),
      baseCurrency: z.string().default('USD'),
    })
    .optional(),

  // Appearance settings
  appearance: z
    .object({
      theme: z.enum(['light', 'dark', 'system']).default('system'),
      accentColor: z.string().default('#2563eb'),
      fontSize: z.enum(['small', 'medium', 'large']).default('medium'),
      compactMode: z.boolean().default(false),
      showAnimations: z.boolean().default(true),
    })
    .optional(),

  // Notification settings
  notifications: z
    .object({
      email: z.boolean().default(true),
      push: z.boolean().default(true),
      desktop: z.boolean().default(false),
      sound: z.boolean().default(true),
      frequency: z.enum(['immediate', 'hourly', 'daily', 'weekly']).default('daily'),
      types: z
        .object({
          transactions: z.boolean().default(true),
          balanceChanges: z.boolean().default(true),
          priceAlerts: z.boolean().default(false),
          systemUpdates: z.boolean().default(true),
          securityAlerts: z.boolean().default(true),
        })
        .default({}),
    })
    .optional(),

  // Privacy settings
  privacy: z
    .object({
      shareAnalytics: z.boolean().default(false),
      shareUsageData: z.boolean().default(false),
      showPublicProfile: z.boolean().default(false),
      allowContactFromSupport: z.boolean().default(true),
    })
    .optional(),

  // Dashboard preferences
  dashboard: z
    .object({
      layout: z.enum(['grid', 'list', 'compact']).default('grid'),
      widgets: z.array(z.string()).default(['overview', 'holdings', 'transactions']),
      defaultView: z
        .enum(['overview', 'holdings', 'transactions', 'analytics'])
        .default('overview'),
      showWelcome: z.boolean().default(true),
      autoRefresh: z.boolean().default(true),
      refreshInterval: z.number().min(5).max(300).default(30), // seconds
    })
    .optional(),

  // Data preferences
  data: z
    .object({
      exportFormat: z.enum(['csv', 'json', 'xlsx']).default('csv'),
      dateFormat: z.enum(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD']).default('MM/DD/YYYY'),
      numberFormat: z.enum(['1,234.56', '1.234,56', '1 234.56']).default('1,234.56'),
      backupEnabled: z.boolean().default(false),
      backupFrequency: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
    })
    .optional(),

  // Advanced settings
  advanced: z
    .object({
      debugMode: z.boolean().default(false),
      betaFeatures: z.boolean().default(false),
      apiTimeout: z.number().min(5).max(60).default(30), // seconds
      retryAttempts: z.number().min(1).max(5).default(3),
      cacheEnabled: z.boolean().default(true),
      cacheTTL: z.number().min(60).max(3600).default(300), // seconds
    })
    .optional(),

  // Metadata
  meta: z
    .object({
      version: z.string().default('1.0.0'),
      lastUpdated: z.date().default(() => new Date()),
      deviceId: z.string().optional(),
      syncEnabled: z.boolean().default(true),
    })
    .optional(),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;

export interface SettingsSyncStatus {
  lastSync: Date | null;
  pending: boolean;
  failed: boolean;
  error?: string;
}

class SettingsPersistenceService {
  private static instance: SettingsPersistenceService;
  private readonly STORAGE_KEY = 'scani-user-settings';
  private readonly BACKUP_KEY = 'scani-settings-backup';
  private readonly SYNC_STATUS_KEY = 'scani-sync-status';
  private readonly MAX_BACKUPS = 5;

  private settings: UserSettings = {};
  private syncStatus: SettingsSyncStatus = {
    lastSync: null,
    pending: false,
    failed: false,
  };

  private listeners = new Set<(settings: UserSettings) => void>();
  private syncInterval: NodeJS.Timeout | null = null;

  static getInstance(): SettingsPersistenceService {
    if (!SettingsPersistenceService.instance) {
      SettingsPersistenceService.instance = new SettingsPersistenceService();
    }
    return SettingsPersistenceService.instance;
  }

  private constructor() {
    this.loadFromStorage();
    this.setupAutoSync();
  }

  /**
   * Load settings from localStorage
   */
  private loadFromStorage(): void {
    try {
      if (typeof window === 'undefined') return;

      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Parse dates correctly
        if (parsed.meta?.lastUpdated) {
          parsed.meta.lastUpdated = new Date(parsed.meta.lastUpdated);
        }
        this.settings = UserSettingsSchema.parse(parsed);
      }

      // Load sync status
      const syncStatusStored = localStorage.getItem(this.SYNC_STATUS_KEY);
      if (syncStatusStored) {
        const syncStatus = JSON.parse(syncStatusStored);
        if (syncStatus.lastSync) {
          syncStatus.lastSync = new Date(syncStatus.lastSync);
        }
        this.syncStatus = syncStatus;
      }
    } catch (error) {
      console.error('Failed to load settings from storage:', error);
      this.restoreFromBackup();
    }
  }

  /**
   * Save settings to localStorage
   */
  private saveToStorage(): void {
    try {
      if (typeof window === 'undefined') return;

      // Update metadata
      this.settings.meta = {
        ...this.settings.meta,
        lastUpdated: new Date(),
        version: '1.0.0',
        syncEnabled: this.settings.meta?.syncEnabled ?? true,
      };

      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.settings));

      // Create backup
      this.createBackup();

      // Notify listeners
      this.notifyListeners();
    } catch (error) {
      console.error('Failed to save settings to storage:', error);
    }
  }

  /**
   * Create a backup of current settings
   */
  private createBackup(): void {
    try {
      if (typeof window === 'undefined') return;

      const backups = this.getBackups();
      backups.unshift({
        timestamp: new Date().toISOString(),
        settings: this.settings,
      });

      // Keep only the last MAX_BACKUPS backups
      const trimmedBackups = backups.slice(0, this.MAX_BACKUPS);
      localStorage.setItem(this.BACKUP_KEY, JSON.stringify(trimmedBackups));
    } catch (error) {
      console.error('Failed to create settings backup:', error);
    }
  }

  /**
   * Get all backups
   */
  private getBackups(): Array<{ timestamp: string; settings: UserSettings }> {
    try {
      if (typeof window === 'undefined') return [];

      const stored = localStorage.getItem(this.BACKUP_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.error('Failed to get backups:', error);
      return [];
    }
  }

  /**
   * Restore settings from the most recent backup
   */
  private restoreFromBackup(): void {
    try {
      const backups = this.getBackups();
      if (backups.length > 0) {
        const latestBackup = backups[0];
        if (latestBackup?.settings.meta?.lastUpdated) {
          latestBackup.settings.meta.lastUpdated = new Date(latestBackup.settings.meta.lastUpdated);
        }
        if (latestBackup) {
          this.settings = UserSettingsSchema.parse(latestBackup.settings);
        }
        console.log('Settings restored from backup');
      }
    } catch (error) {
      console.error('Failed to restore from backup:', error);
      // Fall back to default settings
      this.settings = {};
    }
  }

  /**
   * Setup automatic sync with server
   */
  private setupAutoSync(): void {
    if (typeof window === 'undefined') return;

    // Sync every 5 minutes
    this.syncInterval = setInterval(
      () => {
        if (this.shouldSync()) {
          this.syncWithServer();
        }
      },
      5 * 60 * 1000
    );

    // Sync when window becomes visible
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.shouldSync()) {
        this.syncWithServer();
      }
    });

    // Sync before page unload
    window.addEventListener('beforeunload', () => {
      if (this.syncStatus.pending) {
        // Force synchronous sync before unload
        this.syncWithServerSync();
      }
    });
  }

  /**
   * Check if settings should be synced
   */
  private shouldSync(): boolean {
    if (!this.settings.meta?.syncEnabled) return false;
    if (this.syncStatus.pending) return false;

    const lastSync = this.syncStatus.lastSync;
    if (!lastSync) return true;

    const timeSinceLastSync = Date.now() - lastSync.getTime();
    return timeSinceLastSync > 60000; // 1 minute
  }

  /**
   * Sync settings with server (async)
   */
  private async syncWithServer(): Promise<void> {
    try {
      this.syncStatus.pending = true;
      this.syncStatus.failed = false;
      this.syncStatus.error = undefined;

      // TODO: Replace with actual API call
      // await api.updateUserSettings(this.settings);

      this.syncStatus.lastSync = new Date();
      this.syncStatus.pending = false;

      // Save sync status
      localStorage.setItem(this.SYNC_STATUS_KEY, JSON.stringify(this.syncStatus));
    } catch (error) {
      console.error('Failed to sync settings with server:', error);
      this.syncStatus.pending = false;
      this.syncStatus.failed = true;
      this.syncStatus.error = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  /**
   * Sync settings with server (synchronous for page unload)
   */
  private syncWithServerSync(): void {
    // TODO: Implement actual synchronous sync for critical scenarios
    // This is a placeholder for cases where we need to ensure settings are saved
    // before the page unloads (e.g., using navigator.sendBeacon)
    try {
      // TODO: Use navigator.sendBeacon or synchronous XMLHttpRequest
      if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
        // navigator.sendBeacon('/api/settings', JSON.stringify(this.settings));
      }
    } catch (error) {
      console.error('Failed to sync settings synchronously:', error);
    }
  }

  /**
   * Notify all listeners of settings changes
   */
  private notifyListeners(): void {
    this.listeners.forEach((listener) => {
      try {
        listener(this.settings);
      } catch (error) {
        console.error('Error in settings listener:', error);
      }
    });
  }

  /**
   * Get current settings
   */
  getSettings(): UserSettings {
    return { ...this.settings };
  }

  /**
   * Get a specific setting value
   */
  getSetting<T>(path: string, defaultValue?: T): T {
    const keys = path.split('.');
    let current: unknown = this.settings;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return defaultValue as T;
      }
    }

    return current as T;
  }

  /**
   * Update settings (partial update)
   */
  updateSettings(updates: Partial<UserSettings>): void {
    try {
      const newSettings = { ...this.settings, ...updates };
      this.settings = UserSettingsSchema.parse(newSettings);
      this.saveToStorage();
    } catch (error) {
      console.error('Failed to update settings:', error);
      throw error;
    }
  }

  /**
   * Update a specific setting value
   */
  updateSetting<T>(path: string, value: T): void {
    const keys = path.split('.');
    const updates: Record<string, unknown> = {};
    let current = updates;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (key) {
        current[key] = {};
        current = current[key] as Record<string, unknown>;
      }
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey) {
      current[lastKey] = value;
    }
    this.updateSettings(updates);
  }

  /**
   * Reset settings to defaults
   */
  resetSettings(): void {
    this.settings = {};
    this.saveToStorage();
  }

  /**
   * Reset specific settings category
   */
  resetCategory(category: keyof UserSettings): void {
    const newSettings = { ...this.settings };
    delete newSettings[category];
    this.settings = newSettings;
    this.saveToStorage();
  }

  /**
   * Export settings
   */
  exportSettings(): string {
    return JSON.stringify(this.settings, null, 2);
  }

  /**
   * Import settings from JSON
   */
  importSettings(settingsJson: string): void {
    try {
      const parsed = JSON.parse(settingsJson);
      if (parsed.meta?.lastUpdated) {
        parsed.meta.lastUpdated = new Date(parsed.meta.lastUpdated);
      }
      this.settings = UserSettingsSchema.parse(parsed);
      this.saveToStorage();
    } catch (error) {
      console.error('Failed to import settings:', error);
      throw new Error('Invalid settings format');
    }
  }

  /**
   * Add settings change listener
   */
  addListener(listener: (settings: UserSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get sync status
   */
  getSyncStatus(): SettingsSyncStatus {
    return { ...this.syncStatus };
  }

  /**
   * Force sync with server
   */
  async forceSync(): Promise<void> {
    await this.syncWithServer();
  }

  /**
   * Get available backups
   */
  getAvailableBackups(): Array<{ timestamp: string; settings: UserSettings }> {
    return this.getBackups();
  }

  /**
   * Restore from specific backup
   */
  restoreFromSpecificBackup(timestamp: string): void {
    const backups = this.getBackups();
    const backup = backups.find((b) => b.timestamp === timestamp);

    if (!backup) {
      throw new Error('Backup not found');
    }

    try {
      if (backup.settings.meta?.lastUpdated) {
        backup.settings.meta.lastUpdated = new Date(backup.settings.meta.lastUpdated);
      }
      this.settings = UserSettingsSchema.parse(backup.settings);
      this.saveToStorage();
    } catch (error) {
      console.error('Failed to restore from specific backup:', error);
      throw new Error('Invalid backup format');
    }
  }

  /**
   * Cleanup on app shutdown
   */
  cleanup(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.listeners.clear();
  }
}

// Export singleton instance
export const settingsService = SettingsPersistenceService.getInstance();

// React hook for using settings
export function useSettings() {
  const [settings, setSettings] = useState(() => settingsService.getSettings());
  const [syncStatus, setSyncStatus] = useState(() => settingsService.getSyncStatus());

  useEffect(() => {
    const unsubscribe = settingsService.addListener(setSettings);

    // Update sync status periodically
    const statusInterval = setInterval(() => {
      setSyncStatus(settingsService.getSyncStatus());
    }, 1000);

    return () => {
      unsubscribe();
      clearInterval(statusInterval);
    };
  }, []);

  return {
    settings,
    syncStatus,
    updateSettings: (updates: Partial<UserSettings>) => settingsService.updateSettings(updates),
    updateSetting: <T>(path: string, value: T) => settingsService.updateSetting(path, value),
    getSetting: <T>(path: string, defaultValue?: T) =>
      settingsService.getSetting(path, defaultValue),
    resetSettings: () => settingsService.resetSettings(),
    resetCategory: (category: keyof UserSettings) => settingsService.resetCategory(category),
    exportSettings: () => settingsService.exportSettings(),
    importSettings: (json: string) => settingsService.importSettings(json),
    forceSync: () => settingsService.forceSync(),
    getAvailableBackups: () => settingsService.getAvailableBackups(),
    restoreFromBackup: (timestamp: string) => settingsService.restoreFromSpecificBackup(timestamp),
  };
}
