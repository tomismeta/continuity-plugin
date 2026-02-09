/**
 * Checkpoint Manager - Pre-compaction state capture
 * 
 * Captures recovery checkpoints before memory compaction:
 * - Saves session state before context loss
 * - Creates recovery manifests
 * - Enables reconstruction of lost continuity
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "../../../plugins/types.js";

export interface CheckpointData {
  timestamp: string;
  messageCount: number;
  tokenCount?: number;
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  checkpointId: string;
}

export interface CompactionManifest {
  schema_version: string;
  checkpoint: CheckpointData;
  recoveryInfo: {
    originalMessageRange: { start: number; end: number };
    compactedAt: string;
    canRecover: boolean;
  };
}

export class CheckpointManager {
  private readonly manifestPath: string;
  private readonly checkpointsDir: string;

  constructor(
    private readonly storagePath: string,
    private readonly logger: PluginLogger
  ) {
    this.manifestPath = path.join(storagePath, "COMPACTION_MANIFEST.json");
    this.checkpointsDir = path.join(storagePath, "checkpoints");
  }

  /**
   * Create a pre-compaction checkpoint
   */
  async createCheckpoint(data: Omit<CheckpointData, "checkpointId">): Promise<CheckpointData> {
    const checkpointId = `checkpoint-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    const checkpoint: CheckpointData = {
      ...data,
      checkpointId,
    };

    // Ensure checkpoints directory exists
    await fs.mkdir(this.checkpointsDir, { recursive: true });

    // Save checkpoint file
    const checkpointPath = path.join(this.checkpointsDir, `${checkpointId}.json`);
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });

    // Create/update manifest
    const manifest: CompactionManifest = {
      schema_version: "1.0.0",
      checkpoint,
      recoveryInfo: {
        originalMessageRange: {
          start: Math.max(0, data.messageCount - 100),
          end: data.messageCount,
        },
        compactedAt: data.timestamp,
        canRecover: true,
      },
    };

    await fs.writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

    this.logger.info(`[checkpoint] Created checkpoint ${checkpointId} for session ${data.sessionId || "unknown"}`);

    // Cleanup old checkpoints
    await this.cleanupOldCheckpoints();

    return checkpoint;
  }

  /**
   * Get the most recent checkpoint
   */
  async getLastCheckpoint(): Promise<CheckpointData | null> {
    try {
      const manifestContent = await fs.readFile(this.manifestPath, "utf-8");
      const manifest = JSON.parse(manifestContent) as CompactionManifest;
      return manifest.checkpoint;
    } catch {
      return null;
    }
  }

  /**
   * Get the full compaction manifest
   */
  async getManifest(): Promise<CompactionManifest | null> {
    try {
      const content = await fs.readFile(this.manifestPath, "utf-8");
      return JSON.parse(content) as CompactionManifest;
    } catch {
      return null;
    }
  }

  /**
   * List all available checkpoints
   */
  async listCheckpoints(): Promise<CheckpointData[]> {
    const checkpoints: CheckpointData[] = [];

    try {
      const files = await fs.readdir(this.checkpointsDir);
      
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const content = await fs.readFile(path.join(this.checkpointsDir, file), "utf-8");
            const checkpoint = JSON.parse(content) as CheckpointData;
            checkpoints.push(checkpoint);
          } catch {
            // Skip invalid checkpoint files
          }
        }
      }

      // Sort by timestamp (newest first)
      checkpoints.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    } catch {
      // Directory might not exist
    }

    return checkpoints;
  }

  /**
   * Check if recovery is possible from the last checkpoint
   */
  async canRecover(): Promise<boolean> {
    const manifest = await this.getManifest();
    if (!manifest) {
      return false;
    }

    // Check if checkpoint file still exists
    const checkpointPath = path.join(this.checkpointsDir, `${manifest.checkpoint.checkpointId}.json`);
    try {
      await fs.access(checkpointPath);
      return manifest.recoveryInfo.canRecover;
    } catch {
      return false;
    }
  }

  /**
   * Get recovery information for display/logging
   */
  async getRecoveryInfo(): Promise<{
    available: boolean;
    lastCheckpoint?: CheckpointData;
    messageRange?: { start: number; end: number };
  }> {
    const manifest = await this.getManifest();
    
    if (!manifest) {
      return { available: false };
    }

    const canRecover = await this.canRecover();

    return {
      available: canRecover,
      lastCheckpoint: manifest.checkpoint,
      messageRange: manifest.recoveryInfo.originalMessageRange,
    };
  }

  /**
   * Mark a checkpoint as used for recovery
   */
  async markRecovered(checkpointId: string): Promise<void> {
    try {
      const manifest = await this.getManifest();
      if (manifest && manifest.checkpoint.checkpointId === checkpointId) {
        manifest.recoveryInfo.canRecover = false;
        await fs.writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      }
    } catch (error) {
      this.logger.warn(`[checkpoint] Failed to mark checkpoint as recovered: ${error}`);
    }
  }

  // Private methods

  private async cleanupOldCheckpoints(): Promise<void> {
    const MAX_CHECKPOINTS = 50;

    try {
      const checkpoints = await this.listCheckpoints();
      
      if (checkpoints.length > MAX_CHECKPOINTS) {
        const toDelete = checkpoints.slice(MAX_CHECKPOINTS);
        
        for (const checkpoint of toDelete) {
          const checkpointPath = path.join(this.checkpointsDir, `${checkpoint.checkpointId}.json`);
          try {
            await fs.unlink(checkpointPath);
            this.logger.debug(`[checkpoint] Cleaned up old checkpoint ${checkpoint.checkpointId}`);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
