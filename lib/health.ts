/**
 * Health Checker - Continuity system health monitoring
 * 
 * Provides health checks and diagnostics:
 * - Disk space monitoring
 * - Integrity validation
 * - Checkpoint availability
 * - Stream accessibility
 */

import fs from "node:fs/promises";
import type { PluginLogger } from "../../../plugins/types.js";
import type { ContinuityStore } from "./store.js";
import type { IntegrityValidator } from "./integrity.js";

export interface HealthStatus {
  healthy: boolean;
  issues: string[];
  stats: {
    totalActions: number;
    storageSizeMB: number;
    lastActionTime?: string;
    integrityValid: boolean;
    checkpointsAvailable: number;
    diskSpaceMB: number;
  };
}

export class HealthChecker {
  private readonly DISK_WARNING_MB = 500;
  private readonly DISK_CRITICAL_MB = 100;

  constructor(
    private readonly store: ContinuityStore,
    private readonly integrityValidator: IntegrityValidator | null,
    private readonly logger: PluginLogger
  ) {}

  /**
   * Perform a comprehensive health check
   */
  async check(): Promise<HealthStatus> {
    const issues: string[] = [];
    const stats = await this.gatherStats();

    // Check disk space
    if (stats.diskSpaceMB < this.DISK_CRITICAL_MB) {
      issues.push(`CRITICAL: Low disk space (${stats.diskSpaceMB}MB remaining)`);
    } else if (stats.diskSpaceMB < this.DISK_WARNING_MB) {
      issues.push(`WARNING: Disk space low (${stats.diskSpaceMB}MB remaining)`);
    }

    // Check integrity if enabled
    if (this.integrityValidator) {
      const integrityResult = await this.integrityValidator.validateStream();
      stats.integrityValid = integrityResult.valid;
      
      if (!integrityResult.valid) {
        issues.push(`Integrity errors: ${integrityResult.errors.length} issues found`);
        
        // Log first few errors
        for (const error of integrityResult.errors.slice(0, 3)) {
          issues.push(`  - ${error.type} at seq ${error.sequence}: ${error.details}`);
        }
      }
    } else {
      stats.integrityValid = true; // No integrity checking enabled
    }

    // Check if we can write to storage
    const canWrite = await this.testWriteAccess();
    if (!canWrite) {
      issues.push("CRITICAL: Cannot write to storage directory");
    }

    // Check recent activity
    if (stats.totalActions === 0) {
      issues.push("WARNING: No actions logged yet");
    } else if (!stats.lastActionTime) {
      issues.push("WARNING: Cannot determine last action time");
    } else {
      const lastAction = new Date(stats.lastActionTime);
      const hoursSince = (Date.now() - lastAction.getTime()) / (1000 * 60 * 60);
      
      if (hoursSince > 24) {
        issues.push(`WARNING: No activity for ${Math.round(hoursSince)} hours`);
      }
    }

    const healthy = issues.length === 0 || 
      !issues.some(i => i.startsWith("CRITICAL"));

    return {
      healthy,
      issues,
      stats,
    };
  }

  /**
   * Quick health check (for status reports)
   */
  async quickCheck(): Promise<{
    ok: boolean;
    message: string;
  }> {
    try {
      const canWrite = await this.testWriteAccess();
      if (!canWrite) {
        return { ok: false, message: "Storage not writable" };
      }

      const stats = await this.store.getStats();
      if (stats.storageSizeMB > 1000) {
        return { ok: true, message: `Large store (${stats.storageSizeMB}MB)` };
      }

      return { ok: true, message: "Healthy" };
    } catch (error) {
      return { ok: false, message: `Error: ${error}` };
    }
  }

  /**
   * Get human-readable status report
   */
  async getStatusReport(): Promise<string> {
    const health = await this.check();
    const stats = health.stats;

    const lines = [
      "╔════════════════════════════════════════════════╗",
      "║         Continuity Status Report               ║",
      "╠════════════════════════════════════════════════╣",
      `║  Overall Health: ${health.healthy ? "✓ HEALTHY" : "✗ ISSUES"}`.padEnd(49) + "║",
      "╠════════════════════════════════════════════════╣",
      "║  Statistics:                                   ║",
      `║    Total Actions: ${stats.totalActions}`.padEnd(49) + "║",
      `║    Storage Used: ${stats.storageSizeMB.toFixed(2)} MB`.padEnd(49) + "║",
      `║    Disk Free: ${stats.diskSpaceMB.toFixed(0)} MB`.padEnd(49) + "║",
      `║    Integrity: ${stats.integrityValid ? "✓ Valid" : "✗ Invalid"}`.padEnd(49) + "║",
      `║    Checkpoints: ${stats.checkpointsAvailable}`.padEnd(49) + "║",
    ];

    if (stats.lastActionTime) {
      const lastAction = new Date(stats.lastActionTime);
      const timeAgo = this.formatTimeAgo(lastAction);
      lines.push(`║    Last Action: ${timeAgo}`.padEnd(49) + "║");
    }

    if (health.issues.length > 0) {
      lines.push("╠════════════════════════════════════════════════╣");
      lines.push("║  Issues:                                       ║");
      for (const issue of health.issues.slice(0, 5)) {
        const truncated = issue.substring(0, 45);
        lines.push(`║    • ${truncated}`.padEnd(49) + "║");
      }
      if (health.issues.length > 5) {
        lines.push(`║    ... and ${health.issues.length - 5} more`.padEnd(49) + "║");
      }
    }

    lines.push("╚════════════════════════════════════════════════╝");

    return lines.join("\n");
  }

  // Private methods

  private async gatherStats(): Promise<HealthStatus["stats"]> {
    const storeStats = await this.store.getStats();
    const diskSpace = await this.getDiskSpace();
    
    // Count checkpoints
    let checkpointsAvailable = 0;
    try {
      const checkpointDir = `${this.store.config.storagePath}/checkpoints`;
      const files = await fs.readdir(checkpointDir);
      checkpointsAvailable = files.filter(f => f.endsWith(".json")).length;
    } catch {
      // Checkpoint dir might not exist
    }

    return {
      totalActions: storeStats.totalActions,
      storageSizeMB: storeStats.storageSizeMB,
      lastActionTime: storeStats.lastActionTime,
      integrityValid: true, // Will be updated by check()
      checkpointsAvailable,
      diskSpaceMB: diskSpace,
    };
  }

  private async getDiskSpace(): Promise<number> {
    try {
      const stats = await fs.statfs(this.store.config.storagePath);
      return Math.floor((stats.bavail * stats.bsize) / 1024 / 1024);
    } catch {
      return Infinity; // Unknown
    }
  }

  private async testWriteAccess(): Promise<boolean> {
    const testFile = `${this.store.config.storagePath}/.write_test_${Date.now()}`;
    try {
      await fs.writeFile(testFile, "test", { mode: 0o600 });
      await fs.unlink(testFile);
      return true;
    } catch {
      return false;
    }
  }

  private formatTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
