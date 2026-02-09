/**
 * Continuity Store - Core append-only action stream storage
 * 
 * Implements the append-only JSONL action stream with:
 * - Configurable log levels (off/judgment/everything)
 * - Integrity hash chaining (optional)
 * - Automatic daily log rotation
 * - Disk space protection
 * - Emergency recovery mode
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { PluginLogger } from "../../../plugins/types.js";

export type LogLevel = "off" | "judgment" | "everything";

export interface ContinuityConfig {
  logLevel: LogLevel;
  storagePath: string;
  enableIntegrityCheck: boolean;
  enablePreCompactionCheckpoint: boolean;
  blockOnPersistenceFailure: boolean;
  maxBackupFiles: number;
  criticalToolPatterns: string[];
  implicitResumeThresholdMinutes?: number;
}

export interface ActionEntry {
  id: string;
  timestamp: string;
  type: string;
  severity: "critical" | "high" | "medium" | "low";
  platform: string;
  description: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  sessionId?: string;
  resumedFrom?: string;
  parentActionId?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredAction extends ActionEntry {
  sequence: number;
  _integrity?: {
    hash: string;
    previous: string | "genesis";
  };
}

interface StreamState {
  sequence: number;
  lastHash: string | null;
}

const MIN_FREE_SPACE_MB = 100;
const EMERGENCY_THRESHOLD_MB = 50;

export class ContinuityStore {
  private state: StreamState = { sequence: 0, lastHash: null };
  private currentStreamPath: string | null = null;
  private emergencyMode = false;
  private initialized = false;

  constructor(
    public readonly config: ContinuityConfig,
    private readonly logger: PluginLogger
  ) {}

  /**
   * Initialize the store
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Ensure storage directory exists
    await fs.mkdir(this.config.storagePath, { recursive: true });
    await fs.mkdir(path.join(this.config.storagePath, "backups"), { recursive: true });
    await fs.mkdir(path.join(this.config.storagePath, "checkpoints"), { recursive: true });

    // Load or initialize stream state
    await this.loadState();

    // Get today's stream path
    this.currentStreamPath = this.getTodayStreamPath();

    // Ensure stream file exists
    try {
      await fs.access(this.currentStreamPath);
    } catch {
      // Create new stream file with header
      await this.writeStreamHeader();
    }

    this.initialized = true;
    this.logger.info(`[continuity-store] Initialized at ${this.currentStreamPath}`);
  }

  /**
   * Close the store
   */
  async close(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    await this.saveState();
    this.initialized = false;
    this.logger.debug("[continuity-store] Closed");
  }

  /**
   * Log an action to the append-only stream
   * Returns true if successfully persisted, false otherwise
   */
  async logAction(entry: ActionEntry): Promise<boolean> {
    if (this.config.logLevel === "off") {
      return true; // Logging disabled, consider it "success"
    }

    if (!this.initialized) {
      this.logger.warn("[continuity-store] Not initialized, cannot log action");
      return false;
    }

    // Check for emergency mode
    if (this.emergencyMode) {
      this.logger.warn("[continuity-store] In emergency mode, logging to emergency recovery");
      return this.logToEmergency(entry);
    }

    // Check disk space
    const hasSpace = await this.checkDiskSpace();
    if (!hasSpace) {
      this.emergencyMode = true;
      this.logger.error("[continuity-store] Low disk space! Entering emergency mode.");
      return this.logToEmergency(entry);
    }

    // Rotate stream if needed (new day)
    const todayPath = this.getTodayStreamPath();
    if (todayPath !== this.currentStreamPath) {
      this.currentStreamPath = todayPath;
      await this.writeStreamHeader();
    }

    // Build stored action with integrity
    const storedAction = await this.buildStoredAction(entry);

    // Validate JSON
    let jsonLine: string;
    try {
      jsonLine = JSON.stringify(storedAction);
    } catch (error) {
      this.logger.error(`[continuity-store] JSON serialization failed: ${error}`);
      return false;
    }

    // Append to stream
    try {
      await fs.appendFile(this.currentStreamPath!, jsonLine + "\n", { mode: 0o600 });
      
      // Sync to ensure durability
      const fd = await fs.open(this.currentStreamPath!, "r+");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }

      // Update state
      this.state.sequence = storedAction.sequence;
      if (this.config.enableIntegrityCheck && storedAction._integrity) {
        this.state.lastHash = storedAction._integrity.hash;
      }

      this.logger.debug(`[continuity-store] Logged action ${storedAction.id} (seq: ${storedAction.sequence})`);
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[continuity-store] Failed to write action: ${errorMsg}`);
      return this.logToEmergency(entry);
    }
  }

  /**
   * Get recent actions from the stream
   */
  async getRecentActions(limit: number = 100): Promise<StoredAction[]> {
    if (!this.currentStreamPath) {
      return [];
    }

    const actions: StoredAction[] = [];
    
    try {
      const content = await fs.readFile(this.currentStreamPath, "utf-8");
      const lines = content.split("\n").filter(line => line.trim());
      
      // Parse from end (most recent)
      for (let i = lines.length - 1; i >= 0 && actions.length < limit; i--) {
        try {
          const action = JSON.parse(lines[i]) as StoredAction;
          actions.unshift(action);
        } catch {
          // Skip invalid lines
        }
      }
    } catch (error) {
      this.logger.warn(`[continuity-store] Failed to read actions: ${error}`);
    }

    return actions;
  }

  /**
   * Query actions by type or criteria
   */
  async queryActions(criteria: {
    type?: string;
    platform?: string;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<StoredAction[]> {
    const actions: StoredAction[] = [];
    const limit = criteria.limit || 100;

    // Get list of stream files (including historical)
    const files = await this.getStreamFiles();
    
    for (const file of files) {
      try {
        const content = await fs.readFile(file, "utf-8");
        const lines = content.split("\n").filter(line => line.trim());
        
        for (const line of lines) {
          try {
            const action = JSON.parse(line) as StoredAction;
            
            // Apply filters
            if (criteria.type && action.type !== criteria.type) continue;
            if (criteria.platform && action.platform !== criteria.platform) continue;
            if (criteria.since && action.timestamp < criteria.since) continue;
            if (criteria.until && action.timestamp > criteria.until) continue;
            
            actions.push(action);
            
            if (actions.length >= limit) {
              return actions;
            }
          } catch {
            // Skip invalid lines
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return actions;
  }

  /**
   * Get the total action count
   */
  async getActionCount(): Promise<number> {
    return this.state.sequence;
  }

  /**
   * Get the timestamp of the last action
   */
  async getLastActionTime(): Promise<string | null> {
    const recentActions = await this.getRecentActions(1);
    return recentActions[0]?.timestamp || null;
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{
    totalActions: number;
    streamFiles: number;
    storageSizeMB: number;
    lastActionTime?: string;
  }> {
    let storageSize = 0;
    let streamFiles = 0;

    try {
      const files = await fs.readdir(this.config.storagePath);
      for (const file of files) {
        if (file.endsWith(".jsonl")) {
          const stat = await fs.stat(path.join(this.config.storagePath, file));
          storageSize += stat.size;
          streamFiles++;
        }
      }
    } catch {
      // Ignore errors
    }

    const recentActions = await this.getRecentActions(1);
    
    return {
      totalActions: this.state.sequence,
      streamFiles,
      storageSizeMB: Math.round(storageSize / 1024 / 1024 * 100) / 100,
      lastActionTime: recentActions[0]?.timestamp,
    };
  }

  /**
   * Verify the integrity of the entire stream
   */
  async verifyIntegrity(): Promise<{
    valid: boolean;
    errors: string[];
    checked: number;
  }> {
    if (!this.config.enableIntegrityCheck) {
      return { valid: true, errors: [], checked: 0 };
    }

    const errors: string[] = [];
    let checked = 0;
    let previousHash: string | null = null;

    const files = await this.getStreamFiles();
    
    for (const file of files) {
      try {
        const content = await fs.readFile(file, "utf-8");
        const lines = content.split("\n").filter(line => line.trim());
        
        for (const line of lines) {
          try {
            const action = JSON.parse(line) as StoredAction;
            checked++;

            if (!action._integrity) {
              // Legacy entry without integrity
              continue;
            }

            // Verify hash chain
            if (action._integrity.previous !== "genesis" && action._integrity.previous !== previousHash) {
              errors.push(`Hash chain broken at sequence ${action.sequence}`);
            }

            // Recalculate hash
            const { _integrity, ...actionWithoutIntegrity } = action;
            const calculatedHash = this.calculateHash(actionWithoutIntegrity, action._integrity.previous);
            
            if (calculatedHash !== action._integrity.hash) {
              errors.push(`Hash mismatch at sequence ${action.sequence}`);
            }

            previousHash = action._integrity.hash;
          } catch {
            errors.push(`Invalid JSON entry at line ${checked}`);
          }
        }
      } catch (error) {
        errors.push(`Failed to read file ${file}: ${error}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      checked,
    };
  }

  // Private methods

  private getTodayStreamPath(): string {
    const date = new Date().toISOString().split("T")[0];
    return path.join(this.config.storagePath, `action-stream-${date}.jsonl`);
  }

  private async getStreamFiles(): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const entries = await fs.readdir(this.config.storagePath);
      for (const entry of entries) {
        if (entry.startsWith("action-stream-") && entry.endsWith(".jsonl")) {
          files.push(path.join(this.config.storagePath, entry));
        }
      }
      files.sort(); // Oldest first
    } catch {
      // Ignore errors
    }

    return files;
  }

  private async writeStreamHeader(): Promise<void> {
    const header = {
      _header: true,
      schema_version: "1.0.0",
      created: new Date().toISOString(),
      integrity_enabled: this.config.enableIntegrityCheck,
    };
    
    await fs.writeFile(
      this.currentStreamPath!,
      JSON.stringify(header) + "\n",
      { mode: 0o600, flag: "wx" }
    );
  }

  private async loadState(): Promise<void> {
    const statePath = path.join(this.config.storagePath, ".state.json");
    
    try {
      const content = await fs.readFile(statePath, "utf-8");
      const state = JSON.parse(content) as StreamState;
      this.state = state;
    } catch {
      // State doesn't exist, start fresh
      this.state = { sequence: 0, lastHash: null };
    }
  }

  private async saveState(): Promise<void> {
    const statePath = path.join(this.config.storagePath, ".state.json");
    
    try {
      await fs.writeFile(statePath, JSON.stringify(this.state), { mode: 0o600 });
    } catch (error) {
      this.logger.warn(`[continuity-store] Failed to save state: ${error}`);
    }
  }

  private async buildStoredAction(entry: ActionEntry): Promise<StoredAction> {
    const sequence = this.state.sequence + 1;

    // Build WITHOUT _integrity first for hash calculation
    const actionForHash: Omit<StoredAction, "_integrity"> = {
      ...entry,
      sequence,
    };

    if (this.config.enableIntegrityCheck) {
      const previousHash = this.state.lastHash || "genesis";
      const hash = this.calculateHash(actionForHash, previousHash);

      // Return with _integrity added AFTER hash calculation
      return {
        ...actionForHash,
        _integrity: { hash, previous: previousHash },
      };
    }

    return actionForHash as StoredAction;
  }

  private calculateHash(action: Omit<StoredAction, "_integrity">, previous: string): string {
    const content = JSON.stringify(action) + previous;
    return createHash("sha256").update(content).digest("hex");
  }

  private async checkDiskSpace(): Promise<boolean> {
    // Note: This is a simplified check. In production, use a proper disk space check
    // that works across platforms
    try {
      const stats = await fs.statfs(this.config.storagePath);
      const freeMB = (stats.bavail * stats.bsize) / 1024 / 1024;
      return freeMB > MIN_FREE_SPACE_MB;
    } catch {
      // If we can't check, assume we have space
      return true;
    }
  }

  private async logToEmergency(entry: ActionEntry): Promise<boolean> {
    const emergencyPath = path.join(this.config.storagePath, "EMERGENCY_RECOVERY.jsonl");
    
    try {
      const emergencyEntry = {
        ...entry,
        _emergency: true,
        _emergency_timestamp: new Date().toISOString(),
      };
      
      await fs.appendFile(emergencyPath, JSON.stringify(emergencyEntry) + "\n", { mode: 0o600 });
      return true;
    } catch (error) {
      this.logger.error(`[continuity-store] Emergency logging failed: ${error}`);
      return false;
    }
  }
}
